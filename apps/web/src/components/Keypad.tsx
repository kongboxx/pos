/**
 * A numeric keypad.
 *
 * The tablet's own keyboard is not used for PINs or cash: it covers half a
 * landscape screen, it autocorrects, and it is a different size on every
 * device. A fixed 3x4 grid of large targets can be hit without looking, which
 * is the whole point at a counter with a queue.
 *
 * Buttons are 64px tall — well over the 44px minimum — because this is the one
 * control used with wet hands.
 */

interface KeypadProps {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  onClear: () => void;
  disabled?: boolean;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export function Keypad({
  onDigit,
  onBackspace,
  onClear,
  disabled,
}: KeypadProps): React.ReactElement {
  return (
    <div className="grid grid-cols-3 gap-3">
      {DIGITS.map((digit) => (
        <KeypadButton key={digit} onPress={() => onDigit(digit)} disabled={disabled}>
          {digit}
        </KeypadButton>
      ))}
      <KeypadButton onPress={onClear} disabled={disabled} tone="muted">
        ล้าง
      </KeypadButton>
      <KeypadButton onPress={() => onDigit('0')} disabled={disabled}>
        0
      </KeypadButton>
      <KeypadButton onPress={onBackspace} disabled={disabled} tone="muted">
        ⌫
      </KeypadButton>
    </div>
  );
}

function KeypadButton({
  children,
  onPress,
  disabled,
  tone = 'normal',
}: {
  children: React.ReactNode;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'normal' | 'muted';
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      className={`btn tnum h-16 text-2xl ${
        tone === 'muted'
          ? 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          : 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200 hover:bg-slate-50'
      } disabled:opacity-40`}
    >
      {children}
    </button>
  );
}
