export type TransactionType = 'income' | 'expense';

export interface Transaction {
  id: string;
  merchant: string;
  category: string;
  amount: number;
  type: TransactionType;
  date: string;
  note?: string;
}

export interface Budget {
  id: string;
  category: string;
  limit: number;
  color: string;
}

export interface Goal {
  id: string;
  name: string;
  target: number;
  saved: number;
  deadline: string;
  emoji: string;
}

interface DashboardState {
  transactions: Transaction[];
  budgets: Budget[];
  goals: Goal[];
  currency: string;
}

const STATE_KEY = 'sfc-budget-state-v1';
const SESSION_KEY = 'sfc-budget-session-v1';

const daysAgo = (days: number) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
};

const seed = (): DashboardState => ({
  currency: 'EUR',
  transactions: [
    { id: 't1', merchant: 'Monthly salary', category: 'Income', amount: 4850, type: 'income', date: daysAgo(2) },
    { id: 't2', merchant: 'Canal House Rent', category: 'Housing', amount: 1420, type: 'expense', date: daysAgo(3) },
    { id: 't3', merchant: 'Albert Heijn', category: 'Groceries', amount: 86.42, type: 'expense', date: daysAgo(5) },
    { id: 't4', merchant: 'NS International', category: 'Transport', amount: 54.8, type: 'expense', date: daysAgo(7) },
    { id: 't5', merchant: 'Freelance project', category: 'Income', amount: 920, type: 'income', date: daysAgo(10) },
    { id: 't6', merchant: 'De Kas', category: 'Dining', amount: 112, type: 'expense', date: daysAgo(12) },
    { id: 't7', merchant: 'Ziggo Internet', category: 'Utilities', amount: 48.5, type: 'expense', date: daysAgo(15) },
    { id: 't8', merchant: 'Pathe', category: 'Entertainment', amount: 31, type: 'expense', date: daysAgo(18) },
    { id: 't9', merchant: 'Bike repair', category: 'Transport', amount: 67.5, type: 'expense', date: daysAgo(22) },
    { id: 't10', merchant: 'Organic market', category: 'Groceries', amount: 63.9, type: 'expense', date: daysAgo(26) }
  ],
  budgets: [
    { id: 'b1', category: 'Housing', limit: 1600, color: '#7557e8' },
    { id: 'b2', category: 'Groceries', limit: 420, color: '#17a673' },
    { id: 'b3', category: 'Dining', limit: 260, color: '#f28b51' },
    { id: 'b4', category: 'Transport', limit: 220, color: '#3d8bfd' },
    { id: 'b5', category: 'Entertainment', limit: 140, color: '#e45e8b' }
  ],
  goals: [
    { id: 'g1', name: 'Japan adventure', target: 5000, saved: 3240, deadline: '2027-04-01', emoji: '✈️' },
    { id: 'g2', name: 'Emergency buffer', target: 10000, saved: 7800, deadline: '2027-12-31', emoji: '🛟' },
    { id: 'g3', name: 'New studio setup', target: 2400, saved: 960, deadline: '2026-11-15', emoji: '🖥️' }
  ]
});

function read(): DashboardState {
  try {
    const value = localStorage.getItem(STATE_KEY);
    return value ? JSON.parse(value) : seed();
  } catch {
    return seed();
  }
}

function write(state: DashboardState) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  window.dispatchEvent(new CustomEvent('budget-data-changed'));
}

export const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const money = (value: number, currency = read().currency) =>
  new Intl.NumberFormat('en-NL', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);

export const dateLabel = (value: string) =>
  new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${value}T12:00:00`));

export const escapeHtml = (value: unknown) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

export const budgetStore = {
  get: read,
  reset() {
    write(seed());
  },
  saveTransaction(transaction: Transaction) {
    const state = read();
    const index = state.transactions.findIndex(item => item.id === transaction.id);
    if (index >= 0) state.transactions[index] = transaction;
    else state.transactions.unshift(transaction);
    write(state);
  },
  deleteTransaction(id: string) {
    const state = read();
    state.transactions = state.transactions.filter(item => item.id !== id);
    write(state);
  },
  saveBudget(budget: Budget) {
    const state = read();
    const index = state.budgets.findIndex(item => item.id === budget.id);
    if (index >= 0) state.budgets[index] = budget;
    else state.budgets.push(budget);
    write(state);
  },
  deleteBudget(id: string) {
    const state = read();
    state.budgets = state.budgets.filter(item => item.id !== id);
    write(state);
  },
  saveGoal(goal: Goal) {
    const state = read();
    const index = state.goals.findIndex(item => item.id === goal.id);
    if (index >= 0) state.goals[index] = goal;
    else state.goals.push(goal);
    write(state);
  },
  deleteGoal(id: string) {
    const state = read();
    state.goals = state.goals.filter(item => item.id !== id);
    write(state);
  },
  setCurrency(currency: string) {
    const state = read();
    state.currency = currency;
    write(state);
  }
};

export const budgetAuth = {
  session() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    } catch {
      return null;
    }
  },
  signIn(email: string, name = '') {
    const session = { email, name: name || email.split('@')[0], signedInAt: Date.now() };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  },
  signOut() {
    sessionStorage.removeItem(SESSION_KEY);
  },
  require() {
    if (this.session()) return true;
    const returnTo = encodeURIComponent(window.location.pathname);
    window.location.href = `/dashboard/login?returnTo=${returnTo}`;
    return false;
  }
};
