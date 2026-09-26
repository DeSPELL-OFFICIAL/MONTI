import { Field } from '../../shared/ui';
import { useCopy } from '../../shared/i18n';
import { CATEGORY_CODES, REGION_CODES, type DateRange, type DiscoverFilters } from './useEvents';

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
  const categoryLabels: Record<number, string> = {
    0: copy.discover.category0,
    1: copy.discover.category1,
    2: copy.discover.category2,
    3: copy.discover.category3,
  };

  return (
    <div className="filters">
      <Field label={copy.discover.filterDate}>
        <select
          value={value.range}
          onChange={(event) => onChange({ ...value, range: event.target.value as DateRange })}
        >
          {RANGES.map((range) => (
            <option key={range} value={range}>
              {rangeLabels[range]}
            </option>
          ))}
        </select>
      </Field>

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
          {CATEGORY_CODES.map((category) => (
            <option key={category} value={String(category)}>
              {categoryLabels[category]}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}
