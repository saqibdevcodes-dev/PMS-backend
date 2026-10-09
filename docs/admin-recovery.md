# First administrator login and password recovery

The frontend's API URL and the backend CLI's database URL are separate settings. A seed run on the Windows workstation with `DATABASE_URL` pointing to localhost updates that workstation's database. It does not create or reset an account on the hosted API. Run the commands below on the hosted backend server, with the same environment/database as the running API. A database hostname of localhost on the server itself can be correct; the machine where the command runs matters.

## Check the account

Deploy the updated backend code and generated Prisma client first. Set `ADMIN_EMAIL` to the intended administrator email in the backend environment; set `ADMIN_PASSWORD` to the password you intend to use. Do not put these credentials in frontend `VITE_*` settings.

```sh
npm run admin:status
```

The command prints the database host/port/name (without connection credentials), whether the account exists, whether it is active, whether it is a staff Super Admin, and whether `ADMIN_PASSWORD` matches its stored password. It does not print passwords or hashes and makes no database changes.

- `exists: false`: run `npm run db:seed` in this same backend environment to create the first administrator. Apply pending migrations and generate the client if needed.
- `configuredPasswordMatches: false` with an active Super Admin: use the explicit reset below.
- `active: false`: another authorized administrator must enable the account. Password recovery does not bypass disabled-account status.
- `superAdmin: false` or `accountType: CUSTOMER`: this command does not grant administrator access or change the account type. Use the correct administrator email.

## Explicit password reset

After checking the displayed target, run:

```sh
npm run admin:reset-password
```

This sets the existing active staff Super Admin's password to `ADMIN_PASSWORD`. The password must be 12–128 characters and contain uppercase, lowercase and a number. The operation revokes all active sessions and unused password-reset tokens, and adds an `auth.admin_password_recovered` audit entry identifying the operator CLI as the source. It preserves customer records, business records, roles and project access.

Sign in at `/login` using `ADMIN_EMAIL` and the configured password. Seeding alone never overwrites an existing password; the ordinary `db:seed` behavior is unchanged. Neither recovery command starts Docker or a backend service.

For installations that run only compiled code, after `npm run build` the equivalent commands are `node dist/scripts/admin-account.js status` and `node dist/scripts/admin-account.js reset-password`, from the backend directory with its runtime environment loaded.
