/**
 * @fileoverview Enter-to-submit for the app's ad-hoc forms.
 *
 * None of these inputs live inside a real <form>, so the browser gives them no
 * implicit submit. Rather than wrapping every screen in a form (which would
 * also mean fighting default page reloads), each group of fields is pointed at
 * the button it belongs to.
 *
 * Textareas are skipped on purpose: Enter is a newline there.
 */

/**
 * Makes Enter in any of `fields` click `button`.
 *
 * @param {(Element|string|null)[]} fields - Inputs, wrappers containing one, or
 *   element ids. Missing entries are ignored so callers can pass optional ones.
 * @param {Element|string} button - The primary action, or its id.
 */
export function submitOnEnter(fields, button) {
  const target = typeof button === "string" ? document.getElementById(button) : button;
  if (!target) return;

  fields.forEach((field) => {
    const node = typeof field === "string" ? document.getElementById(field) : field;
    if (!node) return;
    const input = node.matches?.("input, select") ? node : node.querySelector?.("input, select");
    if (!input) return;
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!target.disabled) target.click();
    });
  });
}
