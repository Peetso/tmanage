import type { ReactNode } from 'react';

/**
 * Fills `{name}` placeholders with values each kept in a bidi isolate, so "25 MB" or a Latin file
 * name stays whole and in order inside an Arabic sentence.
 */
export function withIsolates(
  template: string,
  values: Readonly<Record<string, string>>,
): ReactNode {
  return template.split(/(\{[a-z]+\})/u).map((part, index) => {
    const value = /^\{([a-z]+)\}$/u.exec(part)?.[1];
    return value !== undefined && values[value] !== undefined ? (
      <bdi key={index} dir="ltr">
        {values[value]}
      </bdi>
    ) : (
      part
    );
  });
}
