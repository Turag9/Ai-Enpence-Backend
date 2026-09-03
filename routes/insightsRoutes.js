import express from 'express';
import {
  getMonthlyInsight,
  getSavingsTips,
  getBudgetAlert,
  analyzeTransactions,
  analyzeBudgets,
  getInsightHistory,
} from '../controllers/insightsController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.get('/monthly', getMonthlyInsight);
router.get('/savings-tips', getSavingsTips);
router.get('/analyze-transactions', analyzeTransactions);
router.get('/analyze-budgets', analyzeBudgets);
router.get('/history', getInsightHistory);
router.post('/budget-alert/:budgetId', getBudgetAlert);

export default router;
