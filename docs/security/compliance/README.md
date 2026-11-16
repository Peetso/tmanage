# Compliance readiness — plain-English summary

Written 2026-11-16 for the owner and for answering a client's security or procurement questions.
Details: `control-map.md` (every control, with the file that proves it) and `soc2-readiness.md`
(what is missing and who does it).

## Where we stand

TManage is **not** SOC 2 audited and **not** certified for anything. What we have is the
technical groundwork an auditor would look for, built into the product. Most of what is missing
is paperwork, practice runs and outside reviews, not features.

## What we can truthfully tell a client today

- Each company's data is kept apart from every other company's, and automated tests check
  every route for leaks between companies.
- Passwords are stored with a modern one-way hash. Two-step sign-in (app codes or passkeys) is
  available and a company can make it compulsory. Single sign-on and automatic user provisioning
  are available.
- Sign-ins are rate-limited, idle sessions sign out, and owners can see and end sessions.
- Saved connection secrets (cloud storage, calendars and similar) are encrypted.
- Important actions are written to an audit log that cannot be edited quietly: each entry is
  chained to the one before it, so tampering shows.
- Uploaded files are checked for malware and unsafe content before anyone can open them.
- Backups are encrypted, and the key to open them is kept offline.
- People can download their data and ask for it to be deleted.
- We have a written plan for security incidents, including the deadlines for telling people.
- We publish how to report a security problem to us.

## What we must not say yet

- That we are "SOC 2 compliant", "GDPR compliant" or "certified". Say "we are preparing for
  SOC 2" and "we have built GDPR-ready controls".
- That an outside firm has tested our security. No penetration test has been done.
- That deleting an account removes every trace. Some account and log records are kept and not
  yet anonymised.
- That we offer a signed Data Processing Addendum. It has not been written.

## The biggest open items

1. Get the automatic build checks running again (blocked by the code host's billing).
2. Practise a full restore from backup and keep the record.
3. Finish automatic anonymising when someone is deleted.
4. Write the security policies an auditor will ask for.
5. Owner decisions that cost money: a penetration test, a lawyer for the DPA and privacy
   notice, and a SOC 2 auditor when a client needs the report.
