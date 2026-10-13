/**
 * A labelled choice between a few options, shown as a segmented control (e.g. Vehicles: "All" or
 * "Live only"). Each option is a toggle button; the chosen one is pressed.
 */
export function SegmentedChoice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2">
      <span className="flex-1 text-[15px] font-bold max-sm:text-base">
        {label}
      </span>
      <div
        role="group"
        aria-label={label}
        className="flex rounded-[10px] bg-gray-100 p-[3px] dark:bg-gray-800">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
            className={`h-[34px] rounded-lg px-3 text-[13.5px] font-semibold max-sm:h-[38px] max-sm:px-3.5 max-sm:text-sm ${o.value === value ? "bg-white shadow-sm dark:bg-gray-600" : ""}`}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
