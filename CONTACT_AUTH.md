Email and phone accounts
=======================

Registration accepts name, password and either email or a Bangladesh mobile number. Login accepts `identifier` (email or phone); legacy `email` and `phone` fields are also accepted. Existing email and Google accounts remain supported. Phone authentication uses a password, not SMS/OTP; phone ownership is not verified.

Before enabling phone-only registration against an existing database, run:

```powershell
node src/jobs/migrate-user-contacts.js
```

This uses the same database configuration as the server. It creates partial unique indexes for email and phone before removing the legacy non-sparse email index. It never changes or deletes user documents. Without this migration, the old email index can reject a second phone-only account. The migration has been run against the current configured local test database; other deployments need it separately.

Targeted checks: `node --test tests/auth.validator.test.js tests/auth.phone.test.js`. Controller tests use isolated model stubs and do not create real accounts. Browser checks cover the login and registration UI; a live registration was not submitted.
