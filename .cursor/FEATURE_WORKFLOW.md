# Feature Build Workflow

Based on the feature-build skill. Use this when building new features.

## Phases

1. **Task Selection** — Define acceptance criteria before coding. What does "done" look like?
2. **Component Design** — Sketch or describe the UI. Reuse existing patterns (section, data-table, pulse-card).
3. **Build Loop** — Implement, test in browser, fix. Loop back if criteria fail.
4. **Analytics** — Add events if needed (optional; PostHog when configured).
5. **Commit & Document** — Conventional format: `feat:`, `fix:`, `chore:`. Update CHANGELOG.md.

## Checklist

- [ ] Acceptance criteria defined
- [ ] Working in browser
- [ ] No console errors
- [ ] CHANGELOG updated
- [ ] Conventional commit message

## References

- `views/` — EJS templates
- `public/css/style.css` — Design system classes
- `CHANGELOG.md` — Version history
