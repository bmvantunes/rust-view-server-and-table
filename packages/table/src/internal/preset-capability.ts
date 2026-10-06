export type EffectivePresetOption<TDefaults, TOptions, TKey extends PropertyKey> =
  TOptions extends Record<TKey, infer TValue>
    ? TValue
    : TDefaults extends Record<TKey, infer TValue>
      ? TValue
      : never;

type PresetValidation<TValue> = (parameters: {
  readonly row: unknown;
  readonly value: TValue | null | undefined;
}) => string | undefined;

type PresetEditablePredicate<TValue> = (parameters: {
  readonly row: unknown;
  readonly value: TValue | null | undefined;
}) => boolean;

export type PresetEditingDefaults<TValue> =
  | {
      readonly isEditable?: boolean | PresetEditablePredicate<TValue>;
      readonly blankValue?: never;
      readonly validate?: never;
    }
  | {
      readonly isEditable: true | PresetEditablePredicate<TValue>;
      readonly blankValue?: never;
      readonly validate?: PresetValidation<TValue>;
    }
  | {
      readonly isEditable: true | PresetEditablePredicate<TValue>;
      readonly blankValue: null | undefined;
      readonly validate?: PresetValidation<TValue>;
    };

type IsPotentiallyEditable<TEditable> = [TEditable] extends [false | undefined] ? false : true;
type IsStaticallyEditable<TEditable> = [TEditable] extends [
  true | ((...arguments_: never[]) => unknown),
]
  ? true
  : false;

type EffectiveFieldBlankPresetCapability<TRow, TField extends keyof TRow, TDefaults, TOptions> =
  EffectivePresetOption<TDefaults, TOptions, "blankValue"> extends infer TBlank
    ? [TBlank] extends [never]
      ? EffectivePresetOption<TDefaults, TOptions, "isEditable"> extends infer TEditable
        ? [TEditable] extends [never]
          ? unknown
          : IsPotentiallyEditable<TEditable> extends true
            ? null extends TRow[TField]
              ? never
              : undefined extends TRow[TField]
                ? never
                : unknown
            : unknown
        : never
      : IsStaticallyEditable<EffectivePresetOption<TDefaults, TOptions, "isEditable">> extends true
        ? [TBlank] extends [null]
          ? null extends TRow[TField]
            ? unknown
            : never
          : [TBlank] extends [undefined]
            ? undefined extends TRow[TField]
              ? unknown
              : never
            : never
        : never
    : never;

export type EffectiveFieldPresetCapability<TRow, TField extends keyof TRow, TDefaults, TOptions> = [
  EffectivePresetOption<TDefaults, TOptions, "validate">,
] extends [never]
  ? EffectiveFieldBlankPresetCapability<TRow, TField, TDefaults, TOptions>
  : IsStaticallyEditable<EffectivePresetOption<TDefaults, TOptions, "isEditable">> extends true
    ? EffectiveFieldBlankPresetCapability<TRow, TField, TDefaults, TOptions>
    : never;
