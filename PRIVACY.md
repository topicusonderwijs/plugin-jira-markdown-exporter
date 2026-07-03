# Privacy Policy — Jira Markdown Exporter

**Last updated: 3 July 2026**

Jira Markdown Exporter ("the extension") is an open-source browser extension
that converts the Jira Cloud issue you are viewing into Markdown.

## Summary

**The extension does not collect, store, transmit, or sell any personal data.**
All processing happens locally in your browser.

## What data the extension accesses

To do its job, the extension reads data from the Jira issue you are actively
viewing, through Jira's REST API, using your existing browser session. This may
include issue content such as the title, description, comments, custom fields,
attachments, and the names of people referenced in the issue.

This data is:

- **Processed entirely locally**, within your browser, to generate Markdown.
- **Only ever sent to your own Jira instance** — the same server you are already
  logged in to — in order to retrieve the issue you are viewing.
- **Placed on your clipboard or saved to your device only when you explicitly
  click Copy or Download.**

## What the extension does NOT do

- It does **not** send any data to the developer or to any third-party server.
- It contains **no analytics, telemetry, or tracking** of any kind.
- It does **not** collect personally identifiable information, authentication
  credentials, financial or health data, location, or browsing history.
- It does **not** sell or transfer user data to anyone.
- It does **not** use data for advertising, creditworthiness, or lending.

## Data storage

The only thing the extension stores is your **export preferences** — three
on/off toggles (include comments, include custom fields, include attachments) —
saved locally via `chrome.storage.local` on your own device. No issue content or
personal data is stored.

## Permissions

Each permission is explained in the project
[README](https://github.com/topicusonderwijs/plugin-jira-markdown-exporter#permissions).
Permissions are used solely to read the Jira issue you are viewing and to copy or
download the generated Markdown at your request.

## Open source

The complete source code is public and can be audited by anyone:
<https://github.com/topicusonderwijs/plugin-jira-markdown-exporter>

## Contact

Questions or concerns? Please open an issue:
<https://github.com/topicusonderwijs/plugin-jira-markdown-exporter/issues>

## Changes to this policy

This policy may be updated over time. Any changes will be reflected in this file
with a new "Last updated" date above.
