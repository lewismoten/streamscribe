// One month as a small block calendar: its name, the days of the week, and each day's number, marked when there's
// a meeting, a holiday, or an election that day (all three can be). A marked day says what's on it, and a click goes
// to that day in the list below (a button: the site's addresses use the # part).
export interface DayNote {
  kind: 'meeting' | 'holiday' | 'election';
  text: string;
}
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (value: number) => String(value).padStart(2, '0');
// A month's layout: the weekday it starts on, its number of days, and its name.
function monthLayout(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  return {
    first: start.getUTCDay(),
    days: new Date(Date.UTC(year, month, 0)).getUTCDate(),
    name: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(start)
  };
}

export default function MonthGrid({
  year,
  month,
  notes,
  today
}: {
  year: number;
  month: number; // 1–12
  notes: Map<string, DayNote[]>;
  today: string;
}) {
  const { first, days, name } = monthLayout(year, month);
  const cells: (number | null)[] = [
    ...Array(first).fill(null),
    ...Array.from({ length: days }, (_, index) => index + 1)
  ];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, index) => cells.slice(index * 7, index * 7 + 7));

  return (
    <table className="month-grid">
      <caption>{name}</caption>
      <thead>
        <tr>
          {WEEKDAYS.map((letter, index) => (
            <th key={index} scope="col" abbr={WEEKDAY_NAMES[index]}>
              {letter}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {weeks.map((week, row) => (
          <tr key={row}>
            {week.map((date, column) => {
              if (!date) return <td key={column} aria-hidden="true" className="blank" />;
              const key = `${year}-${pad(month)}-${pad(date)}`;
              const dayNotes = notes.get(key) || [];
              const kinds = [...new Set(dayNotes.map((note) => note.kind))];
              const classes = [...kinds.map((kind) => `has-${kind}`), key === today ? 'today' : ''].join(' ').trim();
              const label = dayNotes.map((note) => note.text).join('; ');
              return (
                <td key={column} className={classes || undefined}>
                  {dayNotes.length ? (
                    <button
                      type="button"
                      title={label}
                      aria-label={`${name.split(' ')[0]} ${date}: ${label}`}
                      onClick={() =>
                        document.getElementById(`day-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                      }
                    >
                      {date}
                    </button>
                  ) : (
                    <span>{date}</span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
