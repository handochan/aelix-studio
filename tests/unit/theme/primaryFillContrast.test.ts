/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve(__dirname, '../../../packages/desktop/src/renderer');
const read = (path: string) => readFileSync(join(rendererRoot, path), 'utf8');

/** WCAG AA for normal-size text. */
const AA_TEXT = 4.5;

function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function parseColor(value: string): [number, number, number] {
  const hex = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number];
  const triplet = value.split(',').map((part) => Number(part.trim()));
  if (triplet.length !== 3 || triplet.some(Number.isNaN)) throw new Error(`Unsupported color: ${value}`);
  return triplet as [number, number, number];
}

function contrast(a: string, b: string): number {
  const luminance = (value: string) => {
    const [r, g, b] = parseColor(value).map(channelLuminance);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Custom properties declared in the first block opened by `selector`. */
function blockVars(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`Missing block: ${selector}`);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, key, value]) => [key, value.trim()]));
}

describe('text on the cyan primary fill', () => {
  const scheme = read('styles/themes/default-color-scheme.css');
  const arco = read('styles/arco-override.css');
  const appearances = {
    light: { scheme: blockVars(scheme, ":root,\n[data-color-scheme='default']"), arco: blockVars(arco, 'body') },
    dark: {
      scheme: blockVars(scheme, "[data-color-scheme='default'][data-theme='dark']"),
      arco: blockVars(arco, "body[arco-theme='dark']"),
    },
  };

  for (const [appearance, vars] of Object.entries(appearances)) {
    it(`keeps --text-on-primary on --primary and its hover fill --aou-8 at AA in ${appearance} mode`, () => {
      for (const fill of ['--primary', '--aou-8']) {
        expect(contrast(vars.scheme['--text-on-primary'], vars.scheme[fill])).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });

    it(`keeps --primary-fill-text on Arco primary-6 and primary-7 at AA in ${appearance} mode`, () => {
      for (const step of ['--primary-6', '--primary-7']) {
        expect(contrast(vars.arco['--primary-fill-text'], vars.arco[step])).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });
  }

  it('styles primary buttons and the active step with the fill text, hovering on primary-7', () => {
    const rule = (selectorPart: string) =>
      [...arco.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(([, selector]) => selector.includes(selectorPart))?.[2] ?? '';
    const textRule = rule(".arco-btn-primary:not(.arco-btn-disabled):not([class*='arco-btn-status-']),");
    expect(textRule).toContain('color: var(--primary-fill-text)');
    const hoverRule = arco.match(
      /\.arco-btn-primary:not\(\.arco-btn-disabled\):not\(\.arco-btn-loading\):not\(\[class\*='arco-btn-status-'\]\):hover \{([^}]*)\}/
    )?.[1];
    expect(hoverRule).toContain('background-color: rgb(var(--primary-7))');
    expect(rule('.arco-steps-item-process .arco-steps-icon')).toContain('color: var(--primary-fill-text)');
  });
});

describe('renderer call sites', () => {
  function sourceFiles(dir: string, extensions: string[]): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path, extensions);
      return extensions.some((ext) => entry.name.endsWith(ext)) ? [path] : [];
    });
  }

  const CYAN_FILL_CLASS =
    /^(bg-(primary|brand)|bg-primary-[5-7]|bg-aou-[5-7]|bg-\[(color:)?var\(--(primary|brand|aou-[5-7])\)\])$/;

  it('pair cyan fill utilities with text-on-primary instead of white text', () => {
    const offenders = sourceFiles(rendererRoot, ['.ts', '.tsx']).flatMap((file) => {
      const literals = readFileSync(file, 'utf8').match(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g) ?? [];
      return literals
        .filter((literal) => {
          const classes = literal
            .slice(1, -1)
            .split(/\s+/)
            // Template literals keep their quoted branches: trim quotes and `${ ? }` around a class.
            .map((token) => token.replace(/^['"`{}$?]+|['"`{}$?,;]+$/g, '').replace(/^([\w-]+:)*!?/, ''));
          return classes.includes('text-white') && classes.some((token) => CYAN_FILL_CLASS.test(token));
        })
        .map((literal) => `${relative(rendererRoot, file)}: ${literal}`);
    });
    expect(offenders).toEqual([]);
  });

  it('keep white text off primary and brand fills in stylesheets', () => {
    const fill = /background(-color)?:\s*(rgb\(var\(--primary-[5-7]\)\)|var\(--(primary|brand|aou-6)\))/;
    const white = /(^|[;\s{])color:\s*(var\(--text-white\)|#fff\b|#ffffff\b|white\b)/;
    const offenders = sourceFiles(rendererRoot, ['.css']).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter(([, , body]) => fill.test(body) && white.test(body))
        .map(([, selector]) => `${relative(rendererRoot, file)}: ${selector.trim()}`)
    );
    expect(offenders).toEqual([]);
  });
});
