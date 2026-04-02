# Blackbook - Development Rules

## UI/UX Design Rules

- **Contact chips/avatars must always be tappable.** Any view that displays a contact avatar or chip (`ContactChip`, `PriorityContactChip`, `ContactAvatarView`, or similar) must be wrapped in a `NavigationLink` that navigates to `ContactDetailView` for that contact. This applies everywhere in the app — dashboard, lists, detail pages, search results, etc. Never display a contact's avatar as a static, non-interactive element.

## Versioning Rules

- **Always ask before committing whether to iterate the version number.** Before creating any commit, ask the user if they want to bump the version. The app version (`MARKETING_VERSION`) and build number (`CURRENT_PROJECT_VERSION`) are defined in `Blackbook.xcodeproj/project.pbxproj`.
