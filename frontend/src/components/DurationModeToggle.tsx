interface DurationModeToggleProps {
  isFlat: boolean;
  onChange: (flat: boolean) => void;
}

export default function DurationModeToggle({ isFlat, onChange }: DurationModeToggleProps) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-[11px] font-medium ${!isFlat ? 'text-primary-300' : 'text-surface-500'}`}>Adet</span>
      <button
        type="button"
        role="switch"
        aria-checked={isFlat}
        onClick={() => onChange(!isFlat)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
          isFlat ? 'bg-primary-600' : 'bg-surface-700'
        }`}
        title="Dizgi/üretim/test sürelerinin adet başına mı yoksa düz toplam iş günü olarak mı yorumlanacağını değiştirir"
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            isFlat ? 'translate-x-4' : 'translate-x-1'
          }`}
        />
      </button>
      <span className={`text-[11px] font-medium ${isFlat ? 'text-primary-300' : 'text-surface-500'}`}>İş Günü</span>
    </div>
  );
}
