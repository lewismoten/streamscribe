import { useState, type FormEvent } from 'react';
import { slug } from '../civic/types.ts';
import { FormButtons } from '../civic/OrgBodyForms.tsx';
import { putRecord, removeRecord } from '../data/useRecords.ts';
import type { Room } from './types.ts';

// Adding or changing a room: its name, its building, and the building's address.
export default function RoomForm({
  id,
  value,
  buildings,
  onDone
}: {
  id: string | null;
  value: Partial<Room>;
  // Buildings already known, with their addresses, to fill in a second room in the same one.
  buildings: Room[];
  onDone: (message: string, id?: string) => void;
}) {
  const [form, setForm] = useState<Room>({
    name: '',
    building: '',
    address: '',
    city: '',
    state: '',
    postal: '',
    ...value
  });
  const field = (name: keyof Room) => ({
    value: String(form[name] || ''),
    onChange: (event: { target: { value: string } }) => setForm({ ...form, [name]: event.target.value })
  });
  // A building already known brings its address.
  const chooseBuilding = (building: string) => {
    const known = buildings.find((item) => item.building === building);
    setForm(
      known && !form.address
        ? { ...form, building, address: known.address, city: known.city, state: known.state, postal: known.postal }
        : { ...form, building }
    );
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const roomId = id || slug(`${form.building} ${form.name}`) || null;
    const saved = await putRecord('rooms', roomId, { ...form, name: form.name.trim(), building: form.building.trim() });
    onDone(`Saved ${form.name.trim()}`, saved);
  };
  const remove = async () => {
    if (!id || !confirm(`Remove ${form.name}? Meetings and schedules there keep their place as unknown.`)) return;
    await removeRecord('rooms', id);
    onDone('Removed');
  };
  return (
    <form className="panel schedule-form" onSubmit={save}>
      <h2>{id ? `Change ${value.name}` : 'New room'}</h2>
      <div className="form-grid">
        <label>
          Room
          <input {...field('name')} placeholder="Board Room" required />
        </label>
        <label>
          Building
          <input
            value={form.building}
            onChange={(event) => chooseBuilding(event.target.value)}
            list="known-buildings"
            placeholder="Warren County Government Center"
            required
          />
          <datalist id="known-buildings">
            {[...new Set(buildings.map((item) => item.building))].map((building) => (
              <option key={building} value={building}>
                {building}
              </option>
            ))}
          </datalist>
        </label>
        <label>
          Street address
          <input {...field('address')} placeholder="220 North Commerce Avenue" autoComplete="street-address" />
        </label>
        <label>
          City
          <input {...field('city')} placeholder="Front Royal" autoComplete="address-level2" />
        </label>
        <label>
          State
          <input {...field('state')} placeholder="VA" autoComplete="address-level1" />
        </label>
        <label>
          ZIP code
          <input {...field('postal')} placeholder="22630" autoComplete="postal-code" />
        </label>
        <label>
          Note
          <input {...field('note')} placeholder="Such as: enter from the side door after hours" />
        </label>
      </div>
      <FormButtons onCancel={() => onDone('')} onRemove={id ? remove : null} />
    </form>
  );
}
