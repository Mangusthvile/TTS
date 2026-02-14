# Architecture Notes

## Folder Split
- `src/features/*`: Feature-level screens, state wrappers, and feature orchestration.
- `components/*`: Shared UI components and composable pieces used across features.
- `services/*`: Data access, storage, queue systems, and IO.
- `hooks/*`: Shared hooks for app-wide behavior.
- `src/app/*`: App shell, routing, and core app state hooks.

## Module Map
- App shell + routing: `src/app/AppShell.tsx`, `src/app/AppRouter.tsx`
- App state hooks: `src/app/state/*`
- Library feature: `src/features/library/*`
- Reader feature: `src/features/reader/*`
- Rules feature: `src/features/rules/*`
- Settings feature: `src/features/settings/*`

## Conventions
- Feature components are colocated with their state and helpers.
- Shared UI stays in `components/` unless a feature owns it exclusively.
- Cross-feature logic should be promoted to `services/` or `hooks/`.
