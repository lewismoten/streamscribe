import { useState } from 'react';
import { mediaUrl } from '../data/hub.ts';
import { initials, shownName, type RosterPerson } from './usePeople.ts';

// Anyone with a name, and a photo when there is one (a private one shows only to people who may see meetings).
export type AvatarPerson = RosterPerson & { photo?: string | null };

// A person's picture: their photo, the roster's emoji for a group entry (such as everyone together), or initials (also
// when the photo can't be loaded).
export default function Avatar({ person, size = 56 }: { person: AvatarPerson; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  const photo = person.photo ? mediaUrl(person.photo) : '';
  const [failed, setFailed] = useState('');
  if (photo && failed !== photo)
    return <img className="avatar" src={photo} alt="" style={style} loading="lazy" onError={() => setFailed(photo)} />;
  return (
    <span className="avatar" style={style} aria-hidden="true" title={shownName(person)}>
      {person.icon || initials(person)}
    </span>
  );
}
