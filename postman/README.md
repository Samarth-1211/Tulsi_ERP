# Tulsi ERP – Postman test collection

`Tulsi_ERP_API.postman_collection.json` holds 209 requests in 20 folders, one folder per task. Each request carries the right role token and a valid payload, plus a test on the status code. Requests named **NEG ·** are negative tests that expect an error such as 400, 403 or 404.

## Run it

1. Seed the DB with `npm run prisma:seed`, set `AUTO_VERIFY_NEW_USERS=true` in `.env`, then start the server with `npm run start:dev`.
2. In Postman, choose **Import**, pick this file, and check the `baseUrl` and `password` collection variables.
3. Run **00 · Setup**. It logs in every role and saves their tokens and IDs. Then run the folders in order, or run the whole collection in the Runner.

From the CLI:

```bash
npx newman run postman/Tulsi_ERP_API.postman_collection.json --delay-request 30
```

The two `file` fields in **09 · Lead import** start out empty. In Postman, pick a sheet made from the template. With Newman, set `src` on those fields first.

## Folders

| Folder | What it tests | Main roles |
|---|---|---|
| 00 Setup | Log in every seeded role and save tokens and IDs | all |
| 01 Auth | refresh, logout, wrong password, unknown field, forgot/reset password | public |
| 02 Organizations | create org with its admin, update, add admin, suspend, reactivate, archive | SUPER_ADMIN |
| 03 Users | create CALLER, DELIVERY_PARTNER and WAREHOUSE_STAFF users, list, deactivate, deletion impact, delete | ADMIN |
| 04 Managers | manager CRUD and status changes | ADMIN |
| 05 Manager team | team-member CRUD, peers | MANAGER |
| 06 Dashboard | `/dashboard/me` for each role | all |
| 07 Allocation settings | round-robin settings | ADMIN |
| 08 Leads | create, dedup and re-enquiry, filters, edit, status changes (IN_PROGRESS, CONVERTED, LOST), follow-ups, notes, assign, bulk actions, delete | ADMIN / MANAGER / CALLER |
| 09 Lead import | template, preview, ALL_TEAMS / MANAGERS_ONLY / CUSTOM import, history | ADMIN |
| 10 Integrations & webhooks | create a generic webhook integration and post leads to it (relay payload, duplicate `leadgen_id`, invalid payload, inactive integration), Meta verification | ADMIN, public |
| 11 Attendance | check-in, check-out with summary, me / team / org views | all except SUPER_ADMIN |
| 12 Employees | summary, profile, overview, team rollup, employee code, own profile, password and email | various |
| 13 Activities | log an activity (needs a check-in first), daily report | various |
| 14 Leave | apply, approve, reject, re-review blocked | CALLER → MANAGER |
| 15 Targets | monthly CALLS / CONVERSIONS targets | MANAGER |
| 16 Tasks | personal and assigned tasks with reminders, complete, delete | CALLER / MANAGER |
| 17 Notifications | bell, mark read, web push subscribe/unsubscribe | CALLER |
| 18 WhatsApp | connect, inbox, send, debug simulator (sending needs real Meta credentials) | ADMIN / CALLER |
| 99 Cleanup | delete the temporary users | ADMIN |

Every run creates new data with unique emails and phone numbers, so you can run the collection again at any time. Caller 3's check-in only succeeds on the first run of the day; later runs get 409, which the tests accept.
