# Hackathon Project Instructions
## Our Specific Project/What you need to Build
A website built for doctors that records doctor and patient interaction.
The website will have the following workflow:
1. take in audio input from new user
2. generate unique voice profile (to distinguish between doctor and patient)
3. record audio during patient visit
4. generate timestamped transcript (Speaker: Doctor | Patient)
5. LLM extraction pipeline
6. generate SOAP Note / Summary
8. create links between claims in SOAP notes to transcript chunk ids

## Mission
Build a polished, functional, deployed website within a 24-hour hackathon.

Prioritize:
1. A working end-to-end core user flow.
2. A compelling live demo.
3. Reliable functionality.
4. Clean, responsive UI.
5. Optional features only after the above are complete.

## Technology
- Node.js
- React
- Express
- TypeScript
- Tailwind CSS
- shadcn/ui when useful
- Supabase only if persistent storage is required
- Playwright for browser testing
- Vercel for deployment
- Python for ML voice to document model

Prefer existing project dependencies over introducing new ones.

## Operating rules
- First inspect relevant files before making changes.
- For substantial tasks, state a short implementation plan.
- Make reasonable low-risk decisions independently.
- Ask me only when a decision changes product scope, architecture, or security.
- Implement the smallest complete solution.
- Do not add features outside the agreed scope.
- Avoid unnecessary abstractions, refactors, dependencies, and rewrites.
- Never claim something works unless you have verified it.
- Never hide build or TypeScript errors.
- Never hardcode secrets or commit .env.local.
- Do not execute destructive Git commands without approval.
- Do not deploy, purchase services, or modify production data without approval.

## Development workflow
For each feature:
1. Identify the required files and expected behavior.
2. Implement the feature.
3. Run relevant checks.
4. Test the actual user flow.
5. Fix failures.
6. Summarize what changed and any remaining issues.

## Definition of done
A feature is complete only when:
- It works through the UI.
- Required backend interactions work.
- Loading, empty, and error states are handled where relevant.
- TypeScript and production build checks pass.
- Desktop and mobile layouts have been checked.
- No critical console errors remain.

If browser testing is unavailable, explicitly report that limitation.

## UI rules
- Use a consistent design system and spacing scale.
- Use shared components for repeated UI.
- Prefer an attractive, modern, uncluttered design.
- Ensure important buttons are functional.
- Ensure forms provide useful feedback.
- Maintain readable contrast and keyboard accessibility.
- Test desktop and mobile layouts.

## Hackathon constraints
- The submission deadline is strict.
- Keep the app demoable at all times.
- Prioritize the agreed must-have features.
- If a feature is taking too long, propose a simpler fallback.
- Avoid major architecture changes during the final quarter.
- Reserve the final hours for deployment, testing, and demo preparation.

## Project state
Maintain PROGRESS.md with:
- Current milestone
- Completed features
- Remaining prioritized tasks
- Architectural decisions
- Known bugs and blockers
- Test and deployment status
- The next specific action

Update PROGRESS.md at major milestones and before handing off work.
Keep this file concise.

## Communication
Be concise. Report:
- What changed
- What was verified
- What is blocked
- What should happen next