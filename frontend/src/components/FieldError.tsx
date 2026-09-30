/**
 * One inline Thai message under a field (task 027).
 *
 * Why this exists: a form with native `required` lets the *browser* answer a bad submit, and that bubble
 * is written in the browser's own language ("Please fill out this field") — nothing the app can
 * translate. So the forms on these pages turn the native check off (`noValidate`) and validate on submit
 * instead, showing this message next to the field.
 */
export default function FieldError({ message }: { message?: string }) {
  if (!message) return null
  return <p className="text-[11px] font-bold text-error mt-1">{message}</p>
}
