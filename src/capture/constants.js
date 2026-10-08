import { execFile as execFileCallback } from 'child_process';
import { SOURCES } from '../config/runtime-config.js';
import { promisify } from 'util';
import { providerFor } from '../providers/index.js';

// Timing and limits for live capture, and the streaming service (provider) behind a source or capture.

export const execFileAsync = promisify(execFileCallback);

// The streaming service's specifics (see src/providers): discovery, segment names, and standby slides.
export const sourceProvider = (source) => providerFor(source);

export const captureProvider = (capture) => providerFor(SOURCES.find((item) => item.key === capture?.sourceKey));

export const defaultDiscoveryPollMs = 30000;

export const defaultSegmentPollMs = 3000;

export const defaultVideoPageRefreshMs = 30000;

export const defaultCaptureStaleMs = 180000;

export const quietProgressIntervalMs = 5000;

export const repeatedQuietProgressIntervalMs = 30000;

export const captureProgressIntervalMs = 30000;

export const hlsRequestTimeoutMs = 15000;

export const hlsSegmentTimeoutMs = 20000;

export const hlsFetchRetries = 2;

export const hlsRetryDelayMs = 500;

export const initialBackfillMaxSegments = 90;

export const silenceThresholdDb = -50;

export const colorBarScanFps = 10;

export const colorBarLookbackSegments = 2;

export const visualTransitionScanFps = 30;

export const visualTransitionThreshold = 60;

export const pageRequestTimeoutMs = 30000;

export const pageFetchRetries = 1;

export const resumeRecentCaptureMs = 12 * 60 * 60 * 1000;

export const maxRedirects = 10;
