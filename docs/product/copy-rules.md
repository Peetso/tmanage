# Copy rules (English and Arabic)

Plan item 55-13. Every label, error and email should read as if a colleague wrote it, in English
or Arabic, with the same words for the same things everywhere.

- Glossary: `packages/domain/src/i18n/glossary.json` (one English term, one Arabic term).
- Lint: `node scripts/i18n/copy-lint.mjs` checks `apps/web/src/lib/i18n/messages/en.json` and
  `ar.json` against these rules. Add `--warnings` to list warnings too.

## 1. Rules for both languages

| Rule                                  | Do                                     | Do not                                     |
| ------------------------------------- | -------------------------------------- | ------------------------------------------ |
| Sentence case                         | Publish to client                      | Publish To Client                          |
| Verb first on buttons and actions     | Request changes                        | Changes request                            |
| One idea per sentence                 | Saved. Your client can see it now.     | Saved and your client, who ..., can see it |
| Short sentences                       | At most 14 words in the UI, 20 in help | Long paragraphs on a button or a toast     |
| Numbers as numerals                   | 3 reviewers                            | three reviewers                            |
| No exclamation marks                  | Project created.                       | Project created!                           |
| No blame                              | That code has expired. Get a new code. | You entered a wrong code.                  |
| Consequence before confirmation       | This will email 3 client reviewers.    | Are you sure?                              |
| Dates: absolute and relative          | 3 Nov (in 2 days)                      | in 2 days (alone)                          |
| Errors: what happened, why, next step | Not saved: the file is over 25 MB. ... | Error 413                                  |
| Permission errors hide hidden objects | You cannot open this item.             | You cannot open "Acme merger plan".        |
| No internal words                     | organization, client view, plan limit  | tenant, projection, entitlement            |
| No internal identifiers               | Your organization                      | organization_id, stack traces, SQLSTATE    |

Brand and product names stay in Latin script in both languages (TManage, Google Drive, OneDrive,
Claude, ChatGPT, MCP). The full list is `brands` in the glossary. Keyboard keys stay Latin too
(Ctrl, Shift, Esc).

## 2. Arabic is written, not translated

- Modern Standard Arabic, polite and direct. Address the reader as «أنت» (formal), or use the
  imperative without a pronoun suffix and «يُرجى» forms, which stay gender-neutral.
- Prefer an active verb to the passive where one exists: «أرسلنا الدعوة» rather than «تم إرسال
  الدعوة», unless the actor is unknown or unimportant.
- No transliterated English nouns where an Arabic term exists, and no English plural on an Arabic
  word. Use the glossary term («مهمة»، «مُخرَج»، «اعتماد»).
- Consistent spelling: hamza on alef where it belongs (أ، إ), ta marbuta (ة) not ha (ه), and alef
  maqsura (ى) only where the word needs it.
- Numerals follow the member's preference; dates show absolute and relative; Hijri is optional and
  display only.
- Mixed-direction text (emails, links, IDs, Latin names) is isolated with `<bdi>` or U+2066-U+2069.
- Example: "This will email 3 client reviewers" / «سيتم إرسال بريد إلى 3 مراجعين لدى العميل».

## 3. What the lint checks

| Rule                  | Level   | Meaning                                                               |
| --------------------- | ------- | --------------------------------------------------------------------- |
| `missing-key`         | error   | a key exists in only one catalog                                      |
| `placeholder`         | error   | Arabic uses a `{placeholder}` that the English string does not have   |
| `forbidden-term`      | error   | tenant, projection, principal, idempotent, entitlement                |
| `internal-leak`       | error   | `something_id`, `SQLSTATE`, `ER_...`, stack traces, `undefined`       |
| `untranslated-ar`     | error   | the Arabic value has Latin words but no Arabic letters (brands aside) |
| `glossary`            | warning | English uses a glossary term and Arabic uses none of its forms        |
| `jargon`              | warning | baseline, payload, slug, UUID, enum, schema, outbox                   |
| `sentence-length`     | warning | over 14 words (UI) or 20 words (keys that name help text)             |
| `exclamation`         | warning | a value ends with "!"                                                 |
| `placeholder-dropped` | warning | Arabic leaves out a placeholder (often right for singular/dual forms) |

Errors that existed when the lint was introduced are listed in
`scripts/i18n/copy-lint-baseline.json`, so the gate started green. A new error fails the run. When
you fix a listed string, the lint reports the entry as stale: delete that line. Regenerate the
whole file only after review: `node scripts/i18n/copy-lint.mjs --update-baseline`.

Warnings never fail the run. Each one has an owner: the person who changes that string fixes it at
the same time.

## 4. Changing the glossary

Add or change a term in `glossary.json`: `en`, `ar`, `accept` (the Arabic stems that count as the
same word, written without diacritics) and `lint` (true only for terms whose meaning does not
change with context). Ask the Arabic reader panel before changing an existing Arabic term.
