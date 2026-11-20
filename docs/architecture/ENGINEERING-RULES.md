# TManage engineering rules: moved

**Status:** binding, by reference. Peter, 2026-11-20: "The system design and the architecture design for the processes in the backend is the most important thing we have."

The rules that used to be here were replaced on 2026-11-20 by a cited, code-mapped and enforced standard:

1. **`ENGINEERING-STANDARD.md`**: the rules. Each has an ID, a verified source, today's `file:line`, a target and a check.
2. `DESIGN-CHECKLIST.md`: fill it before any design or build.
3. `IMPLEMENTATION-PATTERNS.md`, `UI-UX-DESIGN-STANDARD.md`, `PART-DOCS.md` (read the part's `PART.md` before any edit).
4. `VIEWS.md`, `QUALITY-ATTRIBUTES.md`, `FITNESS-FUNCTIONS.md`.
5. `README.md` in this folder: read order, gates and governance.

Where the old sections went:

| Old section                         | New rule IDs                         |
| ----------------------------------- | ------------------------------------ |
| §1 Principles                       | AR-5…AR-12, HT-3, PR-1               |
| §2 Request path and auth            | SE-1…SE-6, HT-1…HT-5, DA-12          |
| §3 Data and migrations              | DA-1…DA-11                           |
| §4 Background processes             | AS-1…AS-6, DA-1                      |
| §5 Runtime and deploy               | RT-1…RT-10, ST-5                     |
| §6 AI features                      | SE-8                                 |
| §7 How sessions work with the rules | README §2, CO-1, CO-2, PR-3          |
| §8 Known defect classes             | ENGINEERING-STANDARD §13 (DC-1…DC-6) |

One correction: old §2.1 put the rate limit last in the guard chain. The code puts it first, on purpose (`apps/api/src/app.module.ts:1262-1264`), and SE-1 and ST-8 now say so.
