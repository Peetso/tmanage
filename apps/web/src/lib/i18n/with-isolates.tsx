import type { ReactNode } from 'react';

/**
 * Fills `{name}` placeholders with values each kept in a bidi isolate, so "25 MB" or a Latin file
 * name stays whole and in order inside an Arabic sentence. The isolate takes its direction from
 * the value's own first strong letter (`<bdi>`'s default), so an Arabic value stays right to left
 * and a value with no letters at all ("21:00 – 07:30", "$249.00") reads left to right.
 */
export function withIsolates(
  template: string,
  values: Readonly<Record<string, string>>,
): ReactNode {
  return template.split(/(\{[a-z]+\})/u).map((part, index) => {
    const value = /^\{([a-z]+)\}$/u.exec(part)?.[1];
    return value !== undefined && values[value] !== undefined ? (
      <bdi key={index}>{values[value]}</bdi>
    ) : (
      part
    );
  });
}
