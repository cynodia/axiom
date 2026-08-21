import type { ValueFormat } from '@cynodia/axiom-core';
import { isPresent, toText } from './mutation/values.js';

/**
 * Semantic value formatting. Formatting is presentation: the stored value never changes,
 * and the graph describes what it wants with a structured `ValueFormat` rather than a
 * function, so the description survives serialization and can be reasoned about.
 */

const DATE_STYLES: Record<string, 'short' | 'medium' | 'long'> = {
  short: 'short',
  medium: 'medium',
  long: 'long',
};

function numberFormat(locale: string, options: Record<string, unknown>): (value: number) => string {
  const intl = (globalThis as unknown as { Intl?: typeof Intl }).Intl;
  if (!intl?.NumberFormat) {
    return (value: number) => String(value);
  }
  const formatter = new intl.NumberFormat(locale, options as Intl.NumberFormatOptions);
  return (value: number) => formatter.format(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function formatDate(value: unknown, locale: string, style: string | undefined, withTime: boolean): string | null {
  const date = asDate(value);
  if (!date) {
    return null;
  }
  const intl = (globalThis as unknown as { Intl?: typeof Intl }).Intl;
  if (!intl?.DateTimeFormat) {
    return date.toISOString();
  }
  const dateStyle = DATE_STYLES[style ?? 'medium'] ?? 'medium';
  const options: Intl.DateTimeFormatOptions = withTime
    ? { dateStyle, timeStyle: dateStyle === 'long' ? 'medium' : 'short' }
    : { dateStyle };
  return new intl.DateTimeFormat(locale, options).format(date);
}

/**
 * Renders a value for display. A value the format cannot describe — a date field holding
 * something that is not a date — falls back to its plain text rather than inventing a
 * plausible-looking result.
 */
export function formatValue(value: unknown, format: ValueFormat | undefined, locale = 'en-US'): string {
  if (!format) {
    return toText(value);
  }
  if (format.kind !== 'boolean' && !isPresent(value)) {
    return '';
  }
  switch (format.kind) {
    case 'text':
      return toText(value);
    case 'number': {
      const numeric = asNumber(value);
      if (numeric === null) {
        return toText(value);
      }
      return numberFormat(locale, {
        useGrouping: format.grouping !== false,
        ...(format.decimals === undefined
          ? {}
          : { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals }),
      })(numeric);
    }
    case 'currency': {
      const numeric = asNumber(value);
      if (numeric === null) {
        return toText(value);
      }
      return numberFormat(locale, {
        style: 'currency',
        currency: format.currency,
        ...(format.decimals === undefined
          ? {}
          : { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals }),
      })(numeric);
    }
    case 'percentage': {
      const numeric = asNumber(value);
      if (numeric === null) {
        return toText(value);
      }
      // A percentage may be stored as a fraction or as a whole number of percent.
      const fraction = format.scale === 'percent' ? numeric / 100 : numeric;
      return numberFormat(locale, {
        style: 'percent',
        ...(format.decimals === undefined
          ? {}
          : { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals }),
      })(fraction);
    }
    case 'boolean': {
      if (!isPresent(value)) {
        return '';
      }
      return value ? format.trueLabel ?? 'Yes' : format.falseLabel ?? 'No';
    }
    case 'date':
      return formatDate(value, locale, format.style, false) ?? toText(value);
    case 'datetime':
      return formatDate(value, locale, format.style, true) ?? toText(value);
    default:
      return toText(value);
  }
}
