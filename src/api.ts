import { Router } from 'express';
import { loadUser } from './auth.js';
import { accountsRouter } from './routes/accounts.js';
import { adminRouter } from './routes/admin.js';
import { banksRouter } from './routes/banks.js';
import { categoriesRouter } from './routes/categories.js';
import { emailAccountsRouter } from './routes/email-accounts.js';
import { monthlyPlansRouter } from './routes/monthly-plans.js';
import { incomeRecordsRouter } from './routes/income-records.js';
import { installmentsRouter } from './routes/installments.js';
import { recurringRulesRouter } from './routes/recurring-rules.js';
import { reportsRouter } from './routes/reports.js';
import { taxDocumentsRouter } from './routes/tax-documents.js';
import { taxEntitiesRouter } from './routes/tax-entities.js';
import { transactionsRouter } from './routes/transactions.js';
import { transferMatchesRouter } from './routes/transfer-matches.js';

export { HttpError } from './http.js';

export const api = Router();

api.get('/me', async (req, res, next) => {
  try {
    res.json({
      user: await loadUser(req),
      signupInviteRequired: req.session.pendingSignup != null,
    });
  } catch (e) {
    next(e);
  }
});

api.use(banksRouter);
api.use(adminRouter);
api.use(emailAccountsRouter);
api.use(accountsRouter);
api.use(categoriesRouter);
api.use(transactionsRouter);
api.use(transferMatchesRouter);
api.use(reportsRouter);
api.use(recurringRulesRouter);
api.use(monthlyPlansRouter);
api.use(incomeRecordsRouter);
api.use(installmentsRouter);
api.use(taxEntitiesRouter);
api.use(taxDocumentsRouter);
