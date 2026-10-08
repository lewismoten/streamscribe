import fs from 'fs';
import path from 'path';
import { TOOLS } from '../config/runtime-config.js';
import { fetchWithDefaults } from '../net/fetch.js';
import { endStream, onceDrain } from '../net/http.js';
import { writeJson } from '../util/fs-utils.js';
import { runCommand } from '../util/process.js';

// Downloading an archived meeting video (resuming a partial download), and reading its length.

// Follows the page's download link (a short-lived signed address) and downloads the MP4, resuming a partial file.
// A signed address that expires mid-download is requested again.
export async function downloadArchive(pageUrl, videoId, videoPath, archiveDir, provider) {
  if (fs.existsSync(videoPath)) {
    console.log(`Archive already downloaded: ${videoPath}`);
    return;
  }
  const partialPath = `${videoPath}.download`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // Asked for again on each attempt: providers can hand out short-lived links.
    const downloadUrl = await provider.archiveDownloadUrl(pageUrl, videoId, fetchWithDefaults);
    const startByte = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
    const response = await fetchWithDefaults(downloadUrl, {
      headers: startByte > 0 ? { range: `bytes=${startByte}-` } : {},
      quiet: true
    });
    if (response.status === 416) {
      break; // already complete
    }
    if (!(response.ok || response.status === 206)) {
      if (attempt === 5) {
        throw new Error(`Archive download returned ${response.status}`);
      }
      continue;
    }
    const append = response.status === 206 && startByte > 0;
    const total =
      Number(response.headers.get('content-range')?.split('/')[1] || response.headers.get('content-length') || 0) ||
      null;
    console.log(
      `${append ? 'Resuming' : 'Downloading'} archive (${total ? `${(total / 1e9).toFixed(2)} GB` : 'size unknown'})${append ? ` from ${(startByte / 1e9).toFixed(2)} GB` : ''}...`
    );
    try {
      await streamToFile(response, partialPath, append, append ? startByte : 0, total);
      break;
    } catch (error) {
      console.log(`  download interrupted (${error.message}); retrying`);
      if (attempt === 5) {
        throw error;
      }
    }
  }
  fs.renameSync(partialPath, videoPath);
  await writeJson(path.join(archiveDir, 'download.json'), {
    pageUrl,
    videoId,
    downloadedAt: new Date().toISOString(),
    bytes: fs.statSync(videoPath).size
  });
}

export async function streamToFile(response, filePath, append, startByte, total) {
  const writer = fs.createWriteStream(filePath, { flags: append ? 'a' : 'w' });
  const reader = response.body.getReader();
  let written = startByte;
  let lastReport = Date.now();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!writer.write(Buffer.from(value))) {
        await onceDrain(writer);
      }
      written += value.length;
      if (Date.now() - lastReport >= 5000) {
        lastReport = Date.now();
        console.log(
          `  ${(written / 1e9).toFixed(2)} GB${total ? ` of ${(total / 1e9).toFixed(2)} GB (${((written / total) * 100).toFixed(1)}%)` : ''}`
        );
      }
    }
    await endStream(writer);
  } catch (error) {
    writer.destroy();
    throw error;
  }
  if (total && written < total) {
    throw new Error(`stopped at ${written} of ${total} bytes`);
  }
}

export async function probeDuration(filePath) {
  const output = await runCommand(TOOLS.ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath
  ]);
  return Number.parseFloat(output.trim());
}
