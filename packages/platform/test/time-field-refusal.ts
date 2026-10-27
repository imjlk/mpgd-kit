/**
 * typia 15's `date-time` and `date` formats themselves refuse a day the month
 * does not have and a space for `T`, so for those inputs typia's error, naming
 * the same field, can come before the kit's own RFC "Timestamps" check. The
 * notifications tests accept either refusal, but only for that field and only
 * as a date format failure.
 *
 * Kept outside `src/` so the package build, which emits every non-test source
 * under `src/`, does not publish it.
 *
 * @param kit The kit's own refusal message.
 * @param typiaPath The field's path below `$input`, as regex source.
 */
export function timeFieldRefusal(kit: RegExp, typiaPath: string): RegExp {
  return new RegExp(
    `${kit.source}|invalid type on \\$input\\.${typiaPath}, expect to be string & Format<"date(?:-time)?">$`,
    'u',
  );
}
