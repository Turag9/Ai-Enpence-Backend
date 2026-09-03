import pool from '../db.js';
import {
  generateMonthlyInsight,
  generateBudgetAlert,
  generateSavingsTips,
  analyzeTransactionList,
  analyzeBudgetList,
} from '../utils/gemini.js';

// How many minutes must pass before we regenerate the same insight type
// for the same user. Prevents hammering the Gemini API on repeated requests.
const CACHE_MINUTES = {
  monthly_insight: 60,
  savings_tips: 30,
  budget_alert: 10,
  transaction_analysis: 10,
  budget_analysis: 10,
};

/**
 * Check if a fresh enough insight already exists in the DB.
 * Returns the cached row or null.
 */
const getCachedInsight = async (userId, insightType) => {
  const minutes = CACHE_MINUTES[insightType] ?? 30;
  const result = await pool.query(
    `SELECT content_json, created_at
     FROM ai_insights
     WHERE user_id = $1
       AND insight_type = $2
       AND created_at > NOW() - ($3 || ' minutes')::INTERVAL
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, insightType, minutes]
  );
  return result.rows[0] ?? null;
};

/**
 * Persist a new insight to the DB and return the saved row.
 */
const saveInsight = async (userId, insightType, contentJson, periodStart = null, periodEnd = null) => {
  const result = await pool.query(
    `INSERT INTO ai_insights (user_id, insight_type, period_start, period_end, content_json)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [userId, insightType, periodStart, periodEnd, JSON.stringify(contentJson)]
  );
  return result.rows[0];
};

// ---------------------------------------------------------------------------
// GET /api/insights/monthly
// ---------------------------------------------------------------------------
export const getMonthlyInsight = async (req, res) => {
  try {
    const cached = await getCachedInsight(req.userId, 'monthly_insight');
    if (cached) {
      return res.json({ ...cached.content_json, cached: true });
    }

    const now = new Date();
    const periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const [summaryRes, breakdownRes, trendRes, userRes] = await Promise.all([
      pool.query(
        `SELECT
          COALESCE(SUM(CASE WHEN type = 'income' THEN amount END), 0) AS total_income,
          COALESCE(SUM(CASE WHEN type = 'expense' THEN amount END), 0) AS total_expenses
         FROM transactions
         WHERE user_id = $1
           AND transaction_date >= date_trunc('month', CURRENT_DATE)`,
        [req.userId]
      ),
      pool.query(
        `SELECT c.name AS category, SUM(t.amount) AS amount
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = $1
           AND t.type = 'expense'
           AND t.transaction_date >= date_trunc('month', CURRENT_DATE)
         GROUP BY c.name
         ORDER BY amount DESC`,
        [req.userId]
      ),
      pool.query(
        `SELECT
          to_char(date_trunc('month', transaction_date), 'YYYY-MM') AS month,
          COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE 0 END), 0) AS income,
          COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS expense
         FROM transactions
         WHERE user_id = $1
           AND transaction_date >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
           AND transaction_date < date_trunc('month', CURRENT_DATE)
         GROUP BY 1
         ORDER BY 1`,
        [req.userId]
      ),
      pool.query('SELECT currency FROM users WHERE id = $1', [req.userId]),
    ]);

    const { total_income, total_expenses } = summaryRes.rows[0];
    const totalIncome = parseFloat(total_income);
    const totalExpenses = parseFloat(total_expenses);
    const savingsRate = totalIncome > 0 ? ((totalIncome - totalExpenses) / totalIncome) * 100 : 0;
    const currency = userRes.rows[0]?.currency ?? 'USD';

    const expenseBreakdown = breakdownRes.rows.map((r) => ({
      category: r.category,
      amount: parseFloat(r.amount),
    }));

    const previousMonths = trendRes.rows.map((r) => ({
      month: r.month,
      income: parseFloat(r.income),
      expense: parseFloat(r.expense),
    }));

    let insightData;
    try {
      insightData = await generateMonthlyInsight({
        totalIncome,
        totalExpenses,
        savingsRate,
        expenseBreakdown,
        previousMonths,
        currency,
      });
    } catch (geminiError) {
      console.error('Gemini monthly insight error:', geminiError);
      return res.status(503).json({ message: 'AI service temporarily unavailable. Please try again.' });
    }

    const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      .toISOString().split('T')[0];

    await saveInsight(req.userId, 'monthly_insight', insightData, periodStart, periodEnd);
    res.json({ ...insightData, cached: false });
  } catch (error) {
    console.error('GetMonthlyInsight error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/insights/savings-tips
// ---------------------------------------------------------------------------
export const getSavingsTips = async (req, res) => {
  try {
    const cached = await getCachedInsight(req.userId, 'savings_tips');
    if (cached) {
      return res.json({ ...cached.content_json, cached: true });
    }

    const [categoriesRes, incomeRes, userRes] = await Promise.all([
      pool.query(
        `SELECT c.name AS category, SUM(t.amount) AS amount,
                COUNT(t.id) AS transaction_count
         FROM transactions t
         JOIN categories c ON c.id = t.category_id
         WHERE t.user_id = $1
           AND t.type = 'expense'
           AND t.transaction_date >= CURRENT_DATE - INTERVAL '30 days'
         GROUP BY c.name
         ORDER BY amount DESC
         LIMIT 5`,
        [req.userId]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS monthly_income
         FROM transactions
         WHERE user_id = $1
           AND type = 'income'
           AND transaction_date >= CURRENT_DATE - INTERVAL '30 days'`,
        [req.userId]
      ),
      pool.query('SELECT currency FROM users WHERE id = $1', [req.userId]),
    ]);

    const topCategories = categoriesRes.rows.map((r) => ({
      category: r.category,
      amount: parseFloat(r.amount),
      transactionCount: parseInt(r.transaction_count, 10),
    }));

    const monthlyIncome = parseFloat(incomeRes.rows[0].monthly_income);
    const currency = userRes.rows[0]?.currency ?? 'USD';

    let tipsData;
    try {
      tipsData = await generateSavingsTips({ topCategories, monthlyIncome, currency });
    } catch (geminiError) {
      console.error('Gemini savings tips error:', geminiError);
      return res.status(503).json({ message: 'AI service temporarily unavailable. Please try again.' });
    }

    await saveInsight(req.userId, 'savings_tips', tipsData);
    res.json({ ...tipsData, cached: false });
  } catch (error) {
    console.error('GetSavingsTips error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// POST /api/insights/budget-alert/:budgetId
// ---------------------------------------------------------------------------
export const getBudgetAlert = async (req, res) => {
  const { budgetId } = req.params;

  try {
    const budgetRes = await pool.query(
      `SELECT
        b.id, b.amount, b.period, b.start_date,
        c.name AS category_name,
        COALESCE(SUM(t.amount), 0) AS spent
       FROM budgets b
       JOIN categories c ON c.id = b.category_id
       LEFT JOIN transactions t
         ON t.category_id = b.category_id
         AND t.user_id = b.user_id
         AND t.type = 'expense'
         AND (
           (b.period = 'monthly' AND t.transaction_date >= date_trunc('month', CURRENT_DATE))
           OR (b.period = 'weekly'  AND t.transaction_date >= date_trunc('week',  CURRENT_DATE))
         )
       WHERE b.id = $1 AND b.user_id = $2
       GROUP BY b.id, c.name`,
      [budgetId, req.userId]
    );

    if (budgetRes.rows.length === 0) {
      return res.status(404).json({ message: 'Budget not found' });
    }

    const budget = budgetRes.rows[0];
    const userRes = await pool.query('SELECT currency FROM users WHERE id = $1', [req.userId]);
    const currency = userRes.rows[0]?.currency ?? 'USD';

    const now = new Date();
    const isMonthly = budget.period === 'monthly';
    const periodStart = isMonthly
      ? new Date(now.getFullYear(), now.getMonth(), 1)
      : new Date(now - ((now.getDay() || 7) - 1) * 86400000);
    const daysIntoPeriod = Math.max(1, Math.ceil((now - periodStart) / 86400000));
    const totalPeriodDays = isMonthly
      ? new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()
      : 7;

    let alertData;
    try {
      alertData = await generateBudgetAlert({
        categoryName: budget.category_name,
        budgetAmount: parseFloat(budget.amount),
        spentAmount: parseFloat(budget.spent),
        daysIntoPeriod,
        totalPeriodDays,
        currency,
      });
    } catch (geminiError) {
      console.error('Gemini budget alert error:', geminiError);
      return res.status(503).json({ message: 'AI service temporarily unavailable. Please try again.' });
    }

    await saveInsight(req.userId, 'budget_alert', { budgetId: budget.id, ...alertData });
    res.json(alertData);
  } catch (error) {
    console.error('GetBudgetAlert error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/insights/analyze-transactions
// ---------------------------------------------------------------------------
export const analyzeTransactions = async (req, res) => {
  try {
    const cached = await getCachedInsight(req.userId, 'transaction_analysis');
    if (cached) {
      return res.json({ ...cached.content_json, cached: true });
    }

    const txRes = await pool.query(
      `SELECT t.id, t.amount, t.type, t.description, t.transaction_date,
              c.name AS category_name
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.user_id = $1
       ORDER BY t.transaction_date DESC, t.id DESC
       LIMIT 50`,
      [req.userId]
    );

    if (txRes.rows.length === 0) {
      return res.status(400).json({ message: 'No transactions to analyze yet.' });
    }

    const userRes = await pool.query('SELECT currency FROM users WHERE id = $1', [req.userId]);
    const currency = userRes.rows[0]?.currency ?? 'USD';

    let analysis;
    try {
      analysis = await analyzeTransactionList({ transactions: txRes.rows, currency });
    } catch (geminiError) {
      console.error('Gemini transaction analysis error:', geminiError);
      return res.status(503).json({ message: 'AI service temporarily unavailable. Please try again.' });
    }

    await saveInsight(req.userId, 'transaction_analysis', analysis);
    res.json({ ...analysis, cached: false });
  } catch (error) {
    console.error('AnalyzeTransactions error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/insights/analyze-budgets
// ---------------------------------------------------------------------------
export const analyzeBudgets = async (req, res) => {
  try {
    const cached = await getCachedInsight(req.userId, 'budget_analysis');
    if (cached) {
      return res.json({ ...cached.content_json, cached: true });
    }

    const budgetRes = await pool.query(
      `SELECT
        b.id, b.amount, b.period,
        c.name AS category_name,
        COALESCE(SUM(t.amount), 0) AS spent
       FROM budgets b
       JOIN categories c ON c.id = b.category_id
       LEFT JOIN transactions t
         ON t.category_id = b.category_id
         AND t.user_id = b.user_id
         AND t.type = 'expense'
         AND (
           (b.period = 'monthly' AND t.transaction_date >= date_trunc('month', CURRENT_DATE))
           OR (b.period = 'weekly'  AND t.transaction_date >= date_trunc('week',  CURRENT_DATE))
         )
       WHERE b.user_id = $1
       GROUP BY b.id, c.name`,
      [req.userId]
    );

    if (budgetRes.rows.length === 0) {
      return res.status(400).json({ message: 'No budgets to analyze yet.' });
    }

    const userRes = await pool.query('SELECT currency FROM users WHERE id = $1', [req.userId]);
    const currency = userRes.rows[0]?.currency ?? 'USD';

    let analysis;
    try {
      analysis = await analyzeBudgetList({ budgets: budgetRes.rows, currency });
    } catch (geminiError) {
      console.error('Gemini budget analysis error:', geminiError);
      return res.status(503).json({ message: 'AI service temporarily unavailable. Please try again.' });
    }

    await saveInsight(req.userId, 'budget_analysis', analysis);
    res.json({ ...analysis, cached: false });
  } catch (error) {
    console.error('AnalyzeBudgets error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ---------------------------------------------------------------------------
// GET /api/insights/history?type=monthly_insight&limit=20
// ---------------------------------------------------------------------------
export const getInsightHistory = async (req, res) => {
  const { type, limit = 20 } = req.query;
  const safeLimit = Math.min(parseInt(limit, 10) || 20, 100);

  const conditions = ['user_id = $1'];
  const values = [req.userId];

  if (type) {
    conditions.push(`insight_type = $2`);
    values.push(type);
  }

  values.push(safeLimit);

  try {
    const result = await pool.query(
      `SELECT id, insight_type, period_start, period_end, content_json, created_at
       FROM ai_insights
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${values.length}`,
      values
    );

    res.json(result.rows);
  } catch (error) {
    console.error('GetInsightHistory error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

export default {
  getMonthlyInsight,
  getSavingsTips,
  getBudgetAlert,
  analyzeTransactions,
  analyzeBudgets,
  getInsightHistory,
};
