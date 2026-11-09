import type { CodeLanguage } from './file-formats';

/**
 * Peter, 2026-11-09 (viewer item 8) — a small built-in syntax highlighter for the code view.
 *
 * No dependency (none is installed) and no HTML: the output is a list of lines of typed tokens,
 * which the stage renders as React `<span>`s, so the file's text never reaches `innerHTML` and
 * the Trusted Types policy is not involved. It colours comments, strings, numbers, keywords,
 * markup tags and attributes, and object keys — enough to read code, not a parser.
 */

export type TokenKind =
  'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'tag' | 'attr' | 'key' | 'heading';

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

export type HighlightedLine = readonly Token[];

interface Grammar {
  readonly line?: readonly string[];
  readonly block?: readonly (readonly [string, string])[];
  readonly quotes?: readonly string[];
  /** Quotes that may span lines (template literals, Go raw strings). */
  readonly multiline?: readonly string[];
  /** Python's `"""` and `'''`. */
  readonly triple?: boolean;
  readonly keywords?: ReadonlySet<string>;
  readonly caseInsensitive?: boolean;
  /** A string followed by `:` is a key (JSON). */
  readonly keys?: boolean;
  /** Identifier characters beyond `[A-Za-z0-9_]` (`$` in JS and PHP, `-` in CSS). */
  readonly identExtra?: string;
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/u).filter(Boolean));

const C_LIKE_LITERALS = 'true false null';

const GRAMMARS: Readonly<Record<Exclude<CodeLanguage, 'markup' | 'yaml' | 'markdown'>, Grammar>> = {
  js: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    multiline: ['`'],
    identExtra: '$',
    keywords: words(`${C_LIKE_LITERALS} undefined break case catch class const continue debugger
        default delete do else export extends finally for from function if import in instanceof
        let new of return super switch this throw try typeof var void while with yield async await
        static get set interface type enum implements private protected public readonly abstract
        declare namespace as satisfies keyof infer is unknown never any string number boolean`),
  },
  python: {
    line: ['#'],
    quotes: ['"', "'"],
    triple: true,
    keywords: words(`True False None and as assert async await break class continue def del elif
        else except finally for from global if import in is lambda nonlocal not or pass raise
        return try while with yield self match case`),
  },
  css: {
    block: [['/*', '*/']],
    line: ['//'],
    quotes: ['"', "'"],
    identExtra: '-',
    keywords: words(`important media import supports keyframes font-face from to and not only
        inherit initial unset none auto`),
  },
  json: { quotes: ['"'], keys: true, keywords: words(C_LIKE_LITERALS) },
  sql: {
    line: ['--'],
    block: [['/*', '*/']],
    quotes: ["'", '"', '`'],
    caseInsensitive: true,
    keywords: words(`select from where and or not insert into values update set delete create
        table alter drop index view join left right inner outer full on as group by order having
        limit offset union all distinct case when then else end null is in like between exists
        primary key foreign references default constraint unique check begin commit rollback
        with returning asc desc count sum avg min max int integer varchar text boolean date`),
  },
  shell: {
    line: ['#'],
    quotes: ['"', "'"],
    identExtra: '$',
    keywords: words(`if then else elif fi for while until do done case esac in function return
        export local readonly echo exit set unset source`),
  },
  php: {
    line: ['//', '#'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    identExtra: '$',
    caseInsensitive: true,
    keywords: words(`${C_LIKE_LITERALS} abstract and array as break case catch class clone const
        continue declare default do echo else elseif empty enddeclare endfor endforeach endif
        endswitch endwhile extends final finally fn for foreach function global if implements
        include include_once instanceof interface isset list match namespace new or print private
        protected public readonly require require_once return static switch throw trait try unset
        use var while yield`),
  },
  go: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    multiline: ['`'],
    keywords: words(`true false nil break case chan const continue default defer else fallthrough
        for func go goto if import interface map package range return select struct switch type
        var string int int64 float64 bool error byte rune`),
  },
  java: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    keywords: words(`${C_LIKE_LITERALS} abstract assert boolean break byte case catch char class
        const continue default do double else enum extends final finally float for if implements
        import instanceof int interface long native new package private protected public return
        short static super switch synchronized this throw throws try void volatile while var val
        fun object when override data sealed companion`),
  },
  c: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    keywords: words(`auto break case char const continue default do double else enum extern
        float for goto if inline int long register return short signed sizeof static struct
        switch typedef union unsigned void volatile while class namespace public private protected
        template typename using virtual new delete nullptr true false bool include define`),
  },
  csharp: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', "'"],
    keywords: words(`${C_LIKE_LITERALS} abstract as async await base bool break case catch class
        const continue decimal default delegate do double else enum event explicit extern finally
        fixed float for foreach if implicit in int interface internal is lock long namespace new
        object operator out override params private protected public readonly ref return sealed
        short static string struct switch this throw try typeof uint using var virtual void while`),
  },
  ruby: {
    line: ['#'],
    quotes: ['"', "'"],
    keywords: words(`true false nil and begin break case class def defined do else elsif end
        ensure for if in module next not or redo rescue retry return self super then unless until
        when while yield require attr_accessor`),
  },
  rust: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"'],
    keywords: words(`true false as async await break const continue crate dyn else enum extern fn
        for if impl in let loop match mod move mut pub ref return self Self static struct super
        trait type unsafe use where while Some None Ok Err`),
  },
  swift: {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"'],
    keywords: words(`true false nil as break case catch class continue default defer do else enum
        extension fallthrough for func guard if import in init inout internal is let private
        protocol public return self static struct subscript super switch throw throws try var
        where while`),
  },
  ini: { line: ['#', ';'], quotes: ['"', "'"], keywords: words('true false on off yes no') },
  plain: {},
};

const NUMBER = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/u;

function isIdentStart(ch: string, extra: string): boolean {
  if (ch.length !== 1) return false;
  return /[A-Za-z_]/u.test(ch) || (extra.includes(ch) && ch !== '-');
}

function isIdentPart(ch: string, extra: string): boolean {
  if (ch.length !== 1) return false;
  return /[A-Za-z0-9_]/u.test(ch) || extra.includes(ch);
}

/** Adds a token, merging it into the last one when the kinds match. */
function push(out: Token[], kind: TokenKind, text: string): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) out[out.length - 1] = { kind, text: last.text + text };
  else out.push({ kind, text });
}

/** The end of a quoted string that starts at `start` (exclusive end index). */
function stringEnd(source: string, start: number, quote: string, multiline: boolean): number {
  let index = start + quote.length;
  while (index < source.length) {
    const ch = source[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (source.startsWith(quote, index)) return index + quote.length;
    if (ch === '\n' && !multiline) return index;
    index += 1;
  }
  return source.length;
}

function tokenizeWith(source: string, grammar: Grammar): Token[] {
  const out: Token[] = [];
  const extra = grammar.identExtra ?? '';
  let index = 0;
  let plainFrom = 0;
  const flush = (to: number) => {
    push(out, 'plain', source.slice(plainFrom, to));
  };
  while (index < source.length) {
    const ch = source[index] as string;
    const block = grammar.block?.find(([open]) => source.startsWith(open, index));
    if (block) {
      flush(index);
      const close = source.indexOf(block[1], index + block[0].length);
      const end = close === -1 ? source.length : close + block[1].length;
      push(out, 'comment', source.slice(index, end));
      index = plainFrom = end;
      continue;
    }
    const line = grammar.line?.find((open) => source.startsWith(open, index));
    if (line) {
      flush(index);
      const newline = source.indexOf('\n', index);
      const end = newline === -1 ? source.length : newline;
      push(out, 'comment', source.slice(index, end));
      index = plainFrom = end;
      continue;
    }
    const triple =
      grammar.triple === true &&
      (source.startsWith('"""', index) || source.startsWith("'''", index))
        ? source.slice(index, index + 3)
        : null;
    const quote =
      triple ??
      grammar.quotes?.find((q) => q === ch) ??
      grammar.multiline?.find((q) => q === ch) ??
      null;
    if (quote) {
      flush(index);
      const spans = triple !== null || (grammar.multiline?.includes(quote) ?? false);
      const end = stringEnd(source, index, quote, spans);
      const text = source.slice(index, end);
      let kind: TokenKind = 'string';
      if (grammar.keys === true) {
        const after = /^\s*:/u.exec(source.slice(end, end + 64));
        if (after) kind = 'key';
      }
      push(out, kind, text);
      index = plainFrom = end;
      continue;
    }
    const before = index > 0 ? (source[index - 1] as string) : '';
    if (/[0-9]/u.test(ch) && !isIdentPart(before, extra)) {
      const match = NUMBER.exec(source.slice(index, index + 64));
      if (match) {
        flush(index);
        push(out, 'number', match[0]);
        index = plainFrom = index + match[0].length;
        continue;
      }
    }
    if (isIdentStart(ch, extra) && !isIdentPart(before, extra)) {
      let end = index + 1;
      while (end < source.length && isIdentPart(source[end] as string, extra)) end += 1;
      const word = source.slice(index, end);
      const probe = grammar.caseInsensitive === true ? word.toLowerCase() : word;
      if (grammar.keywords?.has(probe) === true) {
        flush(index);
        push(out, 'keyword', word);
        plainFrom = end;
      }
      index = end;
      continue;
    }
    index += 1;
  }
  flush(source.length);
  return out;
}

/** HTML, XML, SVG, Vue: comments, tags, attribute names and values. */
function tokenizeMarkup(source: string): Token[] {
  const out: Token[] = [];
  let index = 0;
  let plainFrom = 0;
  const flush = (to: number) => push(out, 'plain', source.slice(plainFrom, to));
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      flush(index);
      const close = source.indexOf('-->', index + 4);
      const end = close === -1 ? source.length : close + 3;
      push(out, 'comment', source.slice(index, end));
      index = plainFrom = end;
      continue;
    }
    const tag = /^<\/?[A-Za-z!?][\w:.-]*/u.exec(source.slice(index, index + 128));
    if (tag) {
      flush(index);
      push(out, 'tag', tag[0]);
      index += tag[0].length;
      // Attributes up to the closing `>`.
      while (index < source.length && source[index] !== '>') {
        const ch = source[index] as string;
        if (ch === '"' || ch === "'") {
          const end = stringEnd(source, index, ch, true);
          push(out, 'string', source.slice(index, end));
          index = end;
          continue;
        }
        const name = /^[A-Za-z_:@#][\w:.@#-]*/u.exec(source.slice(index, index + 128));
        if (name) {
          push(out, 'attr', name[0]);
          index += name[0].length;
          continue;
        }
        push(out, ch === '/' || ch === '?' ? 'tag' : 'plain', ch);
        index += 1;
      }
      if (index < source.length) {
        push(out, 'tag', '>');
        index += 1;
      }
      plainFrom = index;
      continue;
    }
    index += 1;
  }
  flush(source.length);
  return out;
}

/** YAML, line by line: comments, `key:` and quoted values. */
function tokenizeYaml(source: string): Token[] {
  const out: Token[] = [];
  const lines = source.split('\n');
  lines.forEach((line, lineIndex) => {
    const comment = /^(\s*)(#.*)$/u.exec(line);
    if (comment) {
      push(out, 'plain', comment[1] ?? '');
      push(out, 'comment', comment[2] ?? '');
    } else {
      const pair = /^(\s*-?\s*)([^:#'"\s][^:#]*?|"[^"]*"|'[^']*')(:)(\s.*|$)/u.exec(line);
      if (pair) {
        push(out, 'plain', pair[1] ?? '');
        push(out, 'key', pair[2] ?? '');
        push(out, 'plain', pair[3] ?? '');
        for (const token of tokenizeWith(pair[4] ?? '', {
          line: [' #'],
          quotes: ['"', "'"],
          keywords: words('true false null yes no on off ~'),
        })) {
          push(out, token.kind, token.text);
        }
      } else {
        push(out, 'plain', line);
      }
    }
    if (lineIndex < lines.length - 1) push(out, 'plain', '\n');
  });
  return out;
}

/** Markdown, line by line: headings, fences, quotes, list bullets and `inline code`. */
function tokenizeMarkdown(source: string): Token[] {
  const out: Token[] = [];
  const lines = source.split('\n');
  let fenced = false;
  lines.forEach((line, lineIndex) => {
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced;
      push(out, 'comment', line);
    } else if (fenced) {
      push(out, 'string', line);
    } else if (/^\s{0,3}#{1,6}\s/u.test(line)) {
      push(out, 'heading', line);
    } else if (/^\s*>/u.test(line)) {
      push(out, 'comment', line);
    } else {
      const bullet = /^(\s*)([-*+]|\d+\.)(\s)/u.exec(line);
      let rest = line;
      if (bullet) {
        push(out, 'plain', bullet[1] ?? '');
        push(out, 'keyword', bullet[2] ?? '');
        push(out, 'plain', bullet[3] ?? '');
        rest = line.slice(bullet[0].length);
      }
      const parts = rest.split(/(`[^`\n]+`)/u);
      for (const part of parts) {
        push(out, part.startsWith('`') && part.length > 1 ? 'string' : 'plain', part);
      }
    }
    if (lineIndex < lines.length - 1) push(out, 'plain', '\n');
  });
  return out;
}

/** The whole source as typed tokens. */
export function tokenize(source: string, language: CodeLanguage): Token[] {
  if (language === 'markup') return tokenizeMarkup(source);
  if (language === 'yaml') return tokenizeYaml(source);
  if (language === 'markdown') return tokenizeMarkdown(source);
  return tokenizeWith(source, GRAMMARS[language]);
}

/** The source split into lines of tokens (a token spanning lines is split at each newline). */
export function highlightLines(source: string, language: CodeLanguage): HighlightedLine[] {
  const text = source.replace(/\r\n?/gu, '\n');
  const lines: Token[][] = [[]];
  for (const token of tokenize(text, language)) {
    const pieces = token.text.split('\n');
    pieces.forEach((piece, index) => {
      if (index > 0) lines.push([]);
      if (piece !== '')
        (lines[lines.length - 1] as Token[]).push({ kind: token.kind, text: piece });
    });
  }
  return lines;
}
