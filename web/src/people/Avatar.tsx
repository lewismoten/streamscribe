import { mediaUrl } from '../data/hub.ts';
import { initials, shownName, type MeetingPerson } from './usePeople.ts';

// A person's picture: their photo, the roster's emoji for a group entry (such as everyone together), or initials.
export default function Avatar({ person, size = 56 }: { person: MeetingPerson; size?: number }) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  const photo = person.photo ? mediaUrl(person.photo) : '';
  if (photo) return <img className="avatar" src={photo} alt="" style={style} loading="lazy" />;
  return (
    <span className="avatar" style={style} aria-hidden="true" title={shownName(person)}>
      {person.icon || initials(person)}
    </span>
  );
}
