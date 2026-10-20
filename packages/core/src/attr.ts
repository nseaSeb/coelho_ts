import type { Attr, AttrInput, JsonValue, RenderAs, Validator } from "./types.js";

const ALLOWED_SCHEMES = new Set(["http", "https", "mailto", "tel"]);

function oneOfValues(validator: Validator | null): JsonValue[] | null {
  if (validator === null || typeof validator !== "object") return null;
  if ("oneOf" in validator) return validator.oneOf;
  return oneOfValues(validator.nullable);
}

export function buildAttr(input: AttrInput): Attr {
  const validate = input.validate ?? null;
  return {
    default: input.default ?? null,
    required: input.required ?? false,
    validate,
    renderAs: buildRenderAs(input.renderAs ?? null, validate),
  };
}

function buildRenderAs(renderAs: RenderAs | null, validate: Validator | null): RenderAs | null {
  if (renderAs === null) return null;
  if ("style" in renderAs) {
    const allowed = oneOfValues(validate);
    if (allowed === null) {
      throw new Error(
        `renderAs {style: ${JSON.stringify(renderAs.style)}} needs a {oneOf: [...]} validator ` +
          "(nullable or not), because a stored document is not re-validated on the way out " +
          "and the value goes into a style attribute",
      );
    }
    const other = allowed.filter((value) => typeof value !== "string" && value !== null);
    if (other.length > 0) {
      throw new Error(
        `renderAs {style: ${JSON.stringify(renderAs.style)}} needs a validator whose values ` +
          `are strings, since that is what a style carries; got ${JSON.stringify(other)}`,
      );
    }
    return renderAs;
  }
  return { class: { ...renderAs.class } };
}

/** The values a `{style}` attribute may render, read off its validator. */
export function renderValues(attr: Attr): JsonValue[] | null {
  return attr.renderAs !== null && "style" in attr.renderAs ? oneOfValues(attr.validate) : null;
}

/** The key a `{class}` map is looked up with: JSON indexes an object by the string form of the key. */
export function classKey(value: JsonValue): string {
  return value === null ? "null" : String(value);
}

/** Runs a validator against a value: `null` when it passes, otherwise the message. */
export function validateAttr(validator: Validator | null, value: unknown): null | string {
  if (validator === null) return null;
  if (typeof validator === "function") return validator(value);
  if (typeof validator === "string") {
    switch (validator) {
      case "string":
        return typeof value === "string" ? null : "must be a string";
      case "integer":
        return Number.isInteger(value) ? null : "must be an integer";
      case "boolean":
        return typeof value === "boolean" ? null : "must be a boolean";
      case "safe_url":
        return typeof value === "string" ? safeUrlError(value) : "must be a string";
    }
  }
  if ("nullable" in validator) {
    return value === null ? null : validateAttr(validator.nullable, value);
  }
  return validator.oneOf.some((allowed) => sameJson(allowed, value))
    ? null
    : `must be one of ${JSON.stringify(validator.oneOf)}`;
}

// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARS = /[\x00-\x20\x7f]/;
const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):/;

function safeUrlError(value: string): null | string {
  if (UNSAFE_URL_CHARS.test(value)) return "must not contain whitespace or control characters";
  const match = SCHEME.exec(value);
  if (match === null) return null;
  const scheme = match[1] as string;
  return ALLOWED_SCHEMES.has(scheme.toLowerCase()) ? null : `scheme ${JSON.stringify(scheme)} is not allowed`;
}

/** Returns the URL when it is fit to be emitted, or `null`. */
export function safeUrl(url: unknown): string | null {
  return typeof url === "string" && safeUrlError(url) === null ? url : null;
}

/** Structural equality on JSON values, which is what `oneOf` and "equals its default" mean. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameJson(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}
