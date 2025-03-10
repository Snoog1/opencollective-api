import assert from 'assert';

import { groupBy, mapValues, round, set, sumBy, truncate } from 'lodash';

import ExpenseType from '../constants/expense_type';
import TierType from '../constants/tiers';
import { TransactionKind } from '../constants/transaction-kind';
import { TransactionTypes } from '../constants/transactions';
import { toNegative } from '../lib/math';
import { exportToCSV, sumByWhen } from '../lib/utils';
import models, { Op } from '../models';
import Tier from '../models/Tier';

import { getFxRate } from './currency';

const { CREDIT, DEBIT } = TransactionTypes;
const { ADDED_FUNDS, CONTRIBUTION, EXPENSE } = TransactionKind;
const { TICKET } = TierType;
const { CHARGE } = ExpenseType;

/**
 * Export transactions as CSV
 * @param {*} transactions
 */
export function exportTransactions(transactions, attributes) {
  attributes = attributes || [
    'id',
    'createdAt',
    'amount',
    'currency',
    'description',
    'netAmountInCollectiveCurrency',
    'hostCurrency',
    'hostCurrencyFxRate',
    'paymentProcessorFeeInHostCurrency',
    'hostFeeInHostCurrency',
    'platformFeeInHostCurrency',
    'netAmountInHostCurrency',
  ];

  return exportToCSV(transactions, attributes);
}

/**
 * Get transactions between startDate and endDate for collectiveids
 * @param {*} collectiveids
 * @param {*} startDate
 * @param {*} endDate
 * @param {*} limit
 */
export function getTransactions(collectiveids, startDate = new Date('2015-01-01'), endDate = new Date(), options) {
  const where = options.where || {};
  const query = {
    where: {
      ...where,
      CollectiveId: { [Op.in]: collectiveids },
      createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
    },
    order: [['createdAt', 'DESC']],
  };
  if (options.limit) {
    query['limit'] = options.limit;
  }
  if (options.include) {
    query['include'] = options.include;
  }
  return models.Transaction.findAll(query);
}

type FEES_IN_HOST_CURRENCY = {
  paymentProcessorFeeInHostCurrency?: number;
  hostFeeInHostCurrency?: number;
  platformFeeInHostCurrency?: number;
};

const DEFAULT_FEES = {
  paymentProcessorFeeInHostCurrency: 0,
  hostFeeInHostCurrency: 0,
  platformFeeInHostCurrency: 0,
};

/**
 * From a payout provider response, compute all amounts and FX rates in their proper currency
 */
const computeExpenseAmounts = async (
  expense,
  hostCurrency: string,
  expenseToHostFxRate: number,
  fees: FEES_IN_HOST_CURRENCY,
) => {
  const fxRates = { expenseToHost: expenseToHostFxRate, collectiveToHost: undefined, expenseToCollective: undefined };

  // Adapt all FX rates based on what we received from the provider
  if (expense.collective.currency === hostCurrency) {
    // Either the host has the same currency as its collective and we can record everything directly
    // We only support multi-currency expenses for this case
    fxRates.collectiveToHost = 1;
    fxRates.expenseToCollective = expenseToHostFxRate;
  } else if (expense.currency === expense.collective.currency) {
    // Or the expense has the same currency as its collective and we need to convert it to the host currency
    fxRates.collectiveToHost = expenseToHostFxRate;
    fxRates.expenseToCollective = 1;
  } else {
    // Or we're in a tricky situation where we have neither the currency of the host or the currency of the collective
    throw new Error(
      'Multi-currency expenses are not supported for collectives that have a different currency than their hosts',
    );
  }

  // Compute the amounts in the proper currency
  return {
    fxRates,
    amount: {
      inHostCurrency: Math.round(expense.amount * fxRates.expenseToHost),
      inCollectiveCurrency: Math.round(expense.amount * fxRates.expenseToCollective),
      inExpenseCurrency: expense.amount,
    },
    paymentProcessorFee: {
      inHostCurrency: fees.paymentProcessorFeeInHostCurrency,
      inCollectiveCurrency: Math.round(fees.paymentProcessorFeeInHostCurrency / fxRates.collectiveToHost),
      inExpenseCurrency: Math.round(fees.paymentProcessorFeeInHostCurrency / fxRates.expenseToHost),
    },
    hostFee: {
      inHostCurrency: fees.hostFeeInHostCurrency,
      inCollectiveCurrency: Math.round(fees.hostFeeInHostCurrency / fxRates.collectiveToHost),
      inExpenseCurrency: Math.round(fees.hostFeeInHostCurrency / fxRates.expenseToHost),
    },
    platformFee: {
      inHostCurrency: fees.platformFeeInHostCurrency,
      inCollectiveCurrency: Math.round(fees.platformFeeInHostCurrency / fxRates.collectiveToHost),
      inExpenseCurrency: Math.round(fees.platformFeeInHostCurrency / fxRates.expenseToHost),
    },
  };
};

/**
 * A function to create transactions for a given expense that is agnostic of the payout method
 *
 * TODO: This function should accept an `amount` to automatically represent what was really paid from the payment provider,
 * in case it differs from expense.amount (e.g. when fees are put on the payee)
 */
export async function createTransactionsFromPaidExpense(
  host,
  expense,
  fees: FEES_IN_HOST_CURRENCY = DEFAULT_FEES,
  /** Set this to a different value if the expense was paid in a currency that differs form the host's */
  expenseToHostFxRateConfig: number | 'auto',
  /** Will be stored in transaction.data */
  transactionData: Record<string, unknown> = null,
  /** @deprecated Only used for paypal adaptive, to link the payment method */
  paymentMethod = null,
) {
  fees = { ...DEFAULT_FEES, ...fees };
  expense.collective = expense.collective || (await models.Collective.findByPk(expense.CollectiveId));

  // Use the supplied FX rate or fetch a new one for the time of payment
  const expenseToHostFxRate =
    expenseToHostFxRateConfig === 'auto'
      ? await getFxRate(expense.currency, host.currency, new Date())
      : expenseToHostFxRateConfig;

  const expenseDataForTransaction: Record<string, unknown> = { expenseToHostFxRate };
  if (expense.data?.taxes?.length) {
    expenseDataForTransaction['tax'] = {
      ...expense.data.taxes[0],
      id: expense.data.taxes[0].type,
      rate: round(expense.data.taxes[0].rate, 4), // We want to support percentages with up to 2 decimals (e.g. 12.13%)
      percentage: round(expense.data.taxes[0].rate * 100), // @deprecated for legacy compatibility
    };
  }

  // To group all the info we retrieved from the payment. All amounts are expected to be in expense currency
  const { paymentProcessorFeeInHostCurrency, hostFeeInHostCurrency, platformFeeInHostCurrency } = fees;
  const processedAmounts = await computeExpenseAmounts(expense, host.currency, expenseToHostFxRate, fees);
  const transaction = {
    netAmountInCollectiveCurrency:
      -1 *
      (processedAmounts.amount.inCollectiveCurrency +
        processedAmounts.paymentProcessorFee.inCollectiveCurrency +
        processedAmounts.hostFee.inCollectiveCurrency +
        processedAmounts.platformFee.inCollectiveCurrency),
    amountInHostCurrency: -processedAmounts.amount.inHostCurrency,
    hostCurrency: host.currency,
    hostCurrencyFxRate: processedAmounts.fxRates.collectiveToHost,
    paymentProcessorFeeInHostCurrency: toNegative(paymentProcessorFeeInHostCurrency),
    hostFeeInHostCurrency: toNegative(hostFeeInHostCurrency),
    platformFeeInHostCurrency: toNegative(platformFeeInHostCurrency),
    ExpenseId: expense.id,
    type: DEBIT,
    kind: EXPENSE,
    amount: -processedAmounts.amount.inCollectiveCurrency,
    currency: expense.collective.currency, // We always record the transaction in the collective currency
    description: expense.description,
    CreatedByUserId: expense.UserId, // TODO: Should be the person who triggered the payment
    CollectiveId: expense.CollectiveId,
    FromCollectiveId: expense.FromCollectiveId,
    HostCollectiveId: host.id,
    PaymentMethodId: paymentMethod ? paymentMethod.id : null,
    PayoutMethodId: expense.PayoutMethodId,
    taxAmount: computeExpenseTaxes(expense),
    data: {
      ...(transactionData || {}),
      ...expenseDataForTransaction,
    },
  };

  // If the payee is assuming the fees, we adapt the amounts
  if (expense.feesPayer === 'PAYEE') {
    transaction.amount += processedAmounts.paymentProcessorFee.inCollectiveCurrency;
    transaction.amountInHostCurrency += processedAmounts.paymentProcessorFee.inHostCurrency;
    transaction.netAmountInCollectiveCurrency += processedAmounts.paymentProcessorFee.inCollectiveCurrency;
    transaction.data = set(transaction.data || {}, 'feesPayer', 'PAYEE');
  }

  return models.Transaction.createDoubleEntry(transaction);
}

export async function createTransactionsForManuallyPaidExpense(
  host,
  expense,
  paymentProcessorFeeInHostCurrency,
  totalAmountPaidInHostCurrency,
  /** Will be stored in transaction.data */
  transactionData: Record<string, unknown> = {},
) {
  assert(paymentProcessorFeeInHostCurrency >= 0, 'Payment processor fee must be positive');
  assert(totalAmountPaidInHostCurrency > 0, 'Total amount paid must be positive');

  // Values are already adjusted to negative DEBIT values
  const isCoveredByPayee = expense.feesPayer === 'PAYEE';
  const grossAmount = toNegative(totalAmountPaidInHostCurrency - paymentProcessorFeeInHostCurrency);
  const netAmountInCollectiveCurrency = toNegative(totalAmountPaidInHostCurrency);
  const amounts = {
    amount: grossAmount,
    amountInHostCurrency: grossAmount,
    paymentProcessorFeeInHostCurrency: toNegative(paymentProcessorFeeInHostCurrency),
    netAmountInCollectiveCurrency,
    hostCurrencyFxRate: 1,
  };

  if (isCoveredByPayee) {
    set(transactionData, 'feesPayer', 'PAYEE');
    // Not necessary to adjust amounts since the host admin already passes the net amount as the base argument
  }

  // Adjust values if currency from host is different from the currency of the collective.
  if (host.currency !== expense.collective.currency) {
    assert(
      expense.currency === expense.collective.currency,
      'Expense currency must be the same as collective currency',
    );
    amounts.hostCurrencyFxRate = round(Math.abs(grossAmount / expense.amount), 5);
    amounts.amount = round(amounts.amount / amounts.hostCurrencyFxRate);
    amounts.netAmountInCollectiveCurrency = round(amounts.netAmountInCollectiveCurrency / amounts.hostCurrencyFxRate);
  }

  expense.collective = expense.collective || (await models.Collective.findByPk(expense.CollectiveId));
  const expenseDataForTransaction: Record<string, unknown> = {};
  if (expense.data?.taxes?.length) {
    expenseDataForTransaction['tax'] = {
      ...expense.data.taxes[0],
      id: expense.data.taxes[0].type,
      rate: round(expense.data.taxes[0].rate, 4), // We want to support percentages with up to 2 decimals (e.g. 12.13%)
      percentage: round(expense.data.taxes[0].rate * 100), // @deprecated for legacy compatibility
    };
  }

  // To group all the info we retrieved from the payment. All amounts are expected to be in expense currency
  const transaction = {
    ...amounts,
    hostCurrency: host.currency,
    ExpenseId: expense.id,
    type: DEBIT,
    kind: EXPENSE,
    hostFeeInHostCurrency: 0,
    platformFeeInHostCurrency: 0,
    currency: expense.collective.currency, // We always record the transaction in the collective currency
    description: expense.description,
    CreatedByUserId: expense.UserId, // TODO: Should be the person who triggered the payment
    CollectiveId: expense.CollectiveId,
    FromCollectiveId: expense.FromCollectiveId,
    HostCollectiveId: host.id,
    PayoutMethodId: expense.PayoutMethodId,
    taxAmount: computeExpenseTaxes(expense),
    data: {
      isManual: true,
      ...transactionData,
      ...expenseDataForTransaction,
    },
  };

  return models.Transaction.createDoubleEntry(transaction);
}

const computeExpenseTaxes = (expense): number | null => {
  if (!expense.data?.taxes?.length) {
    return null;
  } else {
    const ratesSum = sumBy(expense.data.taxes, 'rate');
    const amountWithoutTaxes = expense.amount / (1 + ratesSum);
    return -Math.round(expense.amount - amountWithoutTaxes) || 0;
  }
};

const kindStrings = {
  ADDED_FUNDS: `Added Funds`,
  BALANCE_TRANSFER: `Balance Transfer`,
  CONTRIBUTION: `Contribution`,
  EXPENSE: `Expense`,
  HOST_FEE: `Host Fee`,
  HOST_FEE_SHARE: `Host Fee Share`,
  HOST_FEE_SHARE_DEBT: `Host Fee Share Debt`,
  PAYMENT_PROCESSOR_COVER: `Cover of Payment Processor Fee`,
  PLATFORM_TIP: `Platform Tip`,
  PLATFORM_TIP_DEBT: `Platform Tip Debt`,
  PREPAID_PAYMENT_METHOD: `Prepaid Payment Method`,
};

export async function generateDescription(transaction, { req = null, full = false } = {}) {
  let baseString = 'Transaction',
    debtString = '',
    tierString = '',
    extraString = '',
    fromString = '',
    toString = '';

  if (transaction.isRefund && transaction.RefundTransactionId) {
    const refundedTransaction = await (req
      ? req.loaders.Transaction.byId.load(transaction.RefundTransactionId)
      : models.Transaction.findByPk(transaction.RefundTransactionId));
    if (refundedTransaction) {
      const refundedTransactionDescription = await generateDescription(refundedTransaction, { req, full });
      return `Refund of "${refundedTransactionDescription}"`;
    }
  }

  let order, expense, subscription;
  let tier: Tier;

  if (transaction.OrderId) {
    order = await (req ? req.loaders.Order.byId.load(transaction.OrderId) : models.Order.findByPk(transaction.OrderId));
  }

  if (kindStrings[transaction.kind]) {
    baseString = kindStrings[transaction.kind];
  }

  if (transaction.kind === CONTRIBUTION) {
    if (order?.TierId) {
      tier = await (req ? req.loaders.Tier.byId.load(order.TierId) : models.Tier.findByPk(order.TierId));
    }
    if (tier) {
      tierString = ` (${truncate(tier.name, { length: 128 })})`;
    }
    if (order?.SubscriptionId) {
      subscription = await (req
        ? req.loaders.Subscription.byId.load(order.SubscriptionId)
        : models.Subscription.findByPk(order.SubscriptionId));
    }
    if (subscription?.interval === 'month') {
      baseString = `Monthly contribution`;
    } else if (subscription?.interval === 'year') {
      baseString = `Yearly contribution`;
    } else if (tier && tier.type === TICKET) {
      baseString = `Registration`;
    }
  } else if (transaction.kind === ADDED_FUNDS) {
    if (order?.description && !order?.description.includes('Financial contribution to')) {
      extraString = ` - ${order.description}`;
    } else if (transaction.description && !transaction.description.includes('Financial contribution to')) {
      extraString = ` - ${transaction.description}`;
    }
  } else if (transaction.kind === EXPENSE) {
    if (transaction.ExpenseId) {
      expense = await (req
        ? req.loaders.Expense.byId.load(transaction.ExpenseId)
        : models.Expense.findByPk(transaction.ExpenseId));
    }
    if (expense) {
      if (expense.type === CHARGE) {
        baseString = 'Virtual Card charge';
      }
      if (expense.type !== CHARGE) {
        extraString = ` - ${expense.description}`;
      }
    }
  }

  const account = await (req
    ? req.loaders.Collective.byId.load(transaction.CollectiveId)
    : models.Collective.findByPk(order.CollectiveId));
  const oppositeAccount = await (req
    ? req.loaders.Collective.byId.load(transaction.FromCollectiveId)
    : models.Collective.findByPk(order.FromCollectiveId));

  if (transaction.isDebt) {
    debtString = ' owed';
    if (transaction.type === CREDIT) {
      if (full) {
        toString = ` by ${account.name.trim()}`;
      }
      fromString = ` to ${oppositeAccount.name.trim()}`;
    } else {
      fromString = ` by ${oppositeAccount.name.trim()}`;
      if (full) {
        toString = ` to ${account.name.trim()}`;
      }
    }
  } else if (transaction.kind === EXPENSE) {
    if (transaction.type === CREDIT) {
      if (full) {
        fromString = ` from ${account.name.trim()}`;
      }
      toString = ` to ${oppositeAccount.name.trim()}`;
    } else {
      fromString = ` from ${oppositeAccount.name.trim()}`;
      if (full) {
        toString = ` to ${account.name.trim()}`;
      }
    }
  } else {
    if (transaction.type === CREDIT) {
      fromString = ` from ${oppositeAccount.name.trim()}`;
      if (full) {
        toString = ` to ${account.name.trim()}`;
      }
    } else {
      if (full) {
        fromString = ` from ${account.name.trim()}`;
      }
      toString = ` to ${oppositeAccount.name.trim()}`;
    }
  }

  return `${baseString}${debtString}${fromString}${toString}${tierString}${extraString}`;
}

/**
 * From a list of transactions, generates an object like:
 * {
 *   [TaxId]: { totalCollected: number, totalPaid: number }
 * }
 */
export const getTaxesSummary = (allTransactions: typeof models.Transaction) => {
  const transactionsWithTaxes = allTransactions.filter(t => t.taxAmount);
  if (!transactionsWithTaxes.length) {
    return null;
  }

  const groupedTransactions = groupBy(transactionsWithTaxes, 'data.tax.id');
  const getTaxAmountInHostCurrency = transaction => transaction.taxAmount * (transaction.hostCurrencyRate || 1) || 0;
  return mapValues(groupedTransactions, transactions => ({
    collected: Math.abs(sumByWhen(transactions, getTaxAmountInHostCurrency, t => t.type === 'CREDIT')),
    paid: sumByWhen(transactions, getTaxAmountInHostCurrency, t => t.type === 'DEBIT'),
  }));
};
