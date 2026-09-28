import { Field } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { THEME_CODES, themeLabels } from '../../shared/eventThemes';
import { REGION_CODES, type DateRange, type DiscoverFilters } from './useEvents';

const RANGES: DateRange[] = ['all', 'today', 'week', 'month'];

export function Filters({
  value,
  onChange,
}: {
  value: DiscoverFilters;
  onChange: (next: DiscoverFilters) => void;
}) {
  const copy = useCopy();
  const rangeLabels: Record<DateRange, string> = {
    all: copy.discover.categoryAll,
    today: copy.discover.dateToday,
    week: copy.discover.dateWeek,
    month: copy.discover.dateMonth,
  };
  // The organiser's list and this one are the same list, read from the same module: a theme
  // somebody can pick has to be a theme somebody else can filter by (shared/eventThemes.ts).
  const themes = themeLabels(copy);

  return (
    <div className="filters">
      {/* 날짜는 가장 자주 쓰는 필터라 칩 한 줄로 늘 보이게 두고, 지역·테마는 접어 첫 화면을
          점유하지 않게 한다(visual R1-10). */}
      <div className="chip-row" role="group" aria-label={copy.discover.filterDate}>
        {RANGES.map((range) => (
          <button
            key={range}
            type="button"
            className={value.range === range ? 'chip chip--on' : 'chip'}
            aria-pressed={value.range === range}
            onClick={() => onChange({ ...value, range })}
          >
            {rangeLabels[range]}
          </button>
        ))}
      </div>

      <details className="more">
        <summary>{copy.discover.moreFilters}</summary>
        <Field label={copy.discover.filterRegion}>
          <select value={value.region} onChange={(event) => onChange({ ...value, region: event.target.value })}>
            <option value="">{copy.discover.categoryAll}</option>
            {REGION_CODES.map((region) => (
              <option key={region} value={region}>
                {copy.discover.regions[region]}
              </option>
            ))}
          </select>
        </Field>

        <Field label={copy.discover.filterCategory}>
        <select
          value={String(value.category)}
          onChange={(event) =>
            onChange({
              ...value,
              category: event.target.value === 'all' ? 'all' : Number(event.target.value),
            })
          }
        >
          <option value="all">{copy.discover.categoryAll}</option>
          {THEME_CODES.map((category) => (
            <option key={category} value={String(category)}>
              {themes[category]}
            </option>
          ))}
        </select>
        </Field>
      </details>
    </div>
  );
}
