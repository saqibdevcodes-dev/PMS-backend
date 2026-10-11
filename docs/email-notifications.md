# Email notifications

The API writes emails to the transactional outbox with the triggering database change. The worker sends them through SMTP, records delivery attempts, and retries temporary failures up to eight times with exponential backoff. SMTP outages do not block successful logins or account creation. Run both `api` and `worker`.

## Events and recipients

| Event                                                                                                                                       | Recipient                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Staff account creation, including first administrator seed                                                                                  | New account holder                                                                                                          |
| Customer account creation with a password                                                                                                   | New customer account holder                                                                                                 |
| Customer invitation and activation                                                                                                          | Invited customer; activation confirmation to the linked account                                                             |
| Customer profile registration without an account                                                                                            | Customer email, when supplied                                                                                               |
| Every successful web or native login                                                                                                        | Account holder, with UTC time, platform, IP and browser/app when available                                                  |
| Password recovery, password change/reset, operator password recovery                                                                        | Account holder                                                                                                              |
| Account enabled/disabled, roles/project access changed, administrator session revocation, portal access removed                             | Affected account holder                                                                                                     |
| Lead assignment/reassignment                                                                                                                | New active staff assignee with project access; unchanged assignees do not receive another assignment email                  |
| Scheduled lead follow-up, call, meeting or site visit                                                                                       | Lead assignee, with the scheduled UTC time                                                                                  |
| Recovery case assignment                                                                                                                    | Assigned active project staff member                                                                                        |
| Approval requested or advanced to another level                                                                                             | Active project staff with the required permission, excluding the requester and previous approvers                           |
| Approval accepted/rejected                                                                                                                  | Requester                                                                                                                   |
| Booking confirmation, cleared payment receipt, payment reversal, NDC issuance, ownership transfer, possession, cancellation, refund payment | Active project staff and the affected customer with communication consent                                                   |
| Upcoming/overdue unpaid installments                                                                                                        | Active project staff and the customer with communication consent; at most one reminder per installment/project-calendar day |
| Newly shared portal document                                                                                                                | Linked customer accounts with current access; email requires communication consent                                          |
| Report or generated document ready                                                                                                          | Requesting account holder                                                                                                   |

Welcome and account security emails are transactional and are independent of a customer's optional property communication consent. Other customer emails recheck consent at delivery. No passwords, session tokens, financial attachments or public file links are included in notifications. Existing invitation/recovery emails contain only the appropriate short-lived activation link or one-time recovery token. Refreshing an access token does not count as a login. Failed logins do not send account emails.

## Production SMTP

In `/var/www/PMS-BE/.env`, configure your provider credentials:

```dotenv
PUBLIC_WEB_URL=https://etihadrealestate.tech
SMTP_HOST=smtp.your-provider.example
SMTP_PORT=587
SMTP_SECURE=false
SMTP_FROM="Etihad Real Estate <your-verified-sender@example.com>"
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
```

Use your provider's real host and verified sender. Port 587 uses STARTTLS with `SMTP_SECURE=false`; port 465 uses `SMTP_SECURE=true`. See [Nodemailer SMTP configuration](https://nodemailer.com/smtp).

**Remove `SMTP_DOCKER_HOST=mail` from production `.env`, or set `SMTP_DOCKER_HOST` to the same real provider hostname.** This variable is only a local Docker override. Compose now respects `SMTP_HOST` instead of forcing the Mailpit test server. Local Node development uses `SMTP_HOST=localhost` on port 1025; local Docker uses `SMTP_DOCKER_HOST=mail` on the same port. Test suites override SMTP settings and only use mocked delivery or local Mailpit.

After pushing these changes, rebuild and recreate the existing VPS services:

```bash
cd /var/www/PMS-BE &&
git pull --ff-only &&
docker compose -p pms-be --profile app build api worker &&
docker compose -p pms-be --profile app up -d --no-deps --force-recreate api worker
```

No database migration is needed for these email changes. Recreating both containers is required for changed `.env` values to take effect. Check `docker compose -p pms-be logs --tail=100 worker` for failed deliveries. Provider acceptance is recorded as success; final inbox placement depends on your provider and domain's mail configuration. SMTP cannot guarantee exactly-once delivery if the connection fails after the provider accepts a message. Emails use a stable Message-ID, and already recorded successful deliveries are skipped on retry.
