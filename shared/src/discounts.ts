// Discounts and promotions on an expense are line items of their own with a minus amount. Each takes
// its amount off one category: one the expense's items use, with the same allowable or disallowable
// standing, so category totals come out as what was actually paid for each.
import { formatGBP, parsePoundsToPence } from './money';

export interface DiscountCheckLine {
  amountPence: number;
  categoryId: number;
  /** As it will be saved: entertainment and depreciation lines are always disallowable. */
  disallowable: boolean;
}

/** A discount or promotion: a line with a minus amount. */
export const isDiscount = (line: { amountPence: number }) => line.amountPence < 0;

/** What a discount is held against: a category, allowable or not. */
const groupKey = (line: { categoryId: number; disallowable: boolean }) => `${line.categoryId}:${line.disallowable ? 1 : 0}`;

export interface DiscountProblem {
  /** The line it's about, or null for the expense as a whole. */
  index: number | null;
  message: string;
}

/**
 * Why an expense's discounts can't be saved, if they can't: each must be in a category (allowable or
 * not) that one of its items is in, and take no more off it than those items cost; the total after
 * discounts must be above £0.00. `categoryName` words the messages.
 */
export function discountProblems(lines: DiscountCheckLine[], categoryName: (id: number) => string = () => 'that category'): DiscountProblem[] {
  const problems: DiscountProblem[] = [];
  const items = lines.filter((l) => !isDiscount(l));
  if (items.length === 0) {
    problems.push({ index: null, message: 'Add at least one item as well as discounts' });
    return problems;
  }
  const itemPence = new Map<string, number>();
  for (const item of items) itemPence.set(groupKey(item), (itemPence.get(groupKey(item)) ?? 0) + item.amountPence);
  const discountPence = new Map<string, number>();
  lines.forEach((line, index) => {
    if (!isDiscount(line)) return;
    const key = groupKey(line);
    if (!itemPence.has(key)) {
      const sameCategory = items.some((i) => i.categoryId === line.categoryId);
      problems.push({
        index,
        message: sameCategory
          ? `A discount must match whether the ${categoryName(line.categoryId)} items it's taken off are disallowable`
          : "A discount must be in the same category as one of the items it's taken off",
      });
      return;
    }
    discountPence.set(key, (discountPence.get(key) ?? 0) - line.amountPence);
  });
  for (const [key, off] of discountPence) {
    const cost = itemPence.get(key)!;
    if (off <= cost) continue;
    const index = lines.findIndex((l) => isDiscount(l) && groupKey(l) === key);
    problems.push({
      index,
      message: `Discounts take ${formatGBP(off)} off ${categoryName(lines[index]!.categoryId)}, more than its items cost (${formatGBP(cost)})`,
    });
  }
  if (problems.length === 0 && lines.reduce((acc, l) => acc + l.amountPence, 0) <= 0) {
    problems.push({ index: null, message: 'The total after discounts must be more than £0.00' });
  }
  return problems;
}

export interface DiscountSplitShare {
  categoryId: number;
  disallowable: boolean;
  amountPence: number;
}

/**
 * A discount on the whole order split across the item groups (category, allowable or not) in
 * proportion to what each cost, in pence that add up exactly (the largest remainders get the odd pennies).
 * `discountPence` is the amount taken off, as a positive number.
 */
export function splitDiscount(items: DiscountCheckLine[], discountPence: number): DiscountSplitShare[] {
  const groups: { categoryId: number; disallowable: boolean; cost: number }[] = [];
  for (const item of items.filter((l) => !isDiscount(l))) {
    const group = groups.find((g) => g.categoryId === item.categoryId && g.disallowable === item.disallowable);
    if (group) group.cost += item.amountPence;
    else groups.push({ categoryId: item.categoryId, disallowable: item.disallowable, cost: item.amountPence });
  }
  const totalCost = groups.reduce((acc, g) => acc + g.cost, 0);
  if (totalCost <= 0) return [];
  const shares = groups.map((g) => {
    const exact = (discountPence * g.cost) / totalCost;
    return { ...g, pence: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = discountPence - shares.reduce((acc, s) => acc + s.pence, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder)) {
    if (left <= 0) break;
    share.pence += 1;
    left -= 1;
  }
  return shares
    .filter((s) => s.pence > 0)
    .map((s) => ({ categoryId: s.categoryId, disallowable: s.disallowable, amountPence: s.pence }));
}

export interface DiscountSummaryLine {
  description: string;
  /** Taken off, as a positive number. */
  amountPence: number;
  categoryId: number;
  disallowable: boolean;
  /** What the category's items (allowable or not, like the discount) cost before all its discounts, and after them. */
  beforePence: number;
  afterPence: number;
}

/** How each discount was applied, worked out from the lines each time it's shown, so it can't go stale. */
export function discountSummary(lines: (DiscountCheckLine & { description: string })[]): DiscountSummaryLine[] {
  const cost = new Map<string, number>();
  const net = new Map<string, number>();
  for (const line of lines) {
    const key = groupKey(line);
    if (!isDiscount(line)) cost.set(key, (cost.get(key) ?? 0) + line.amountPence);
    net.set(key, (net.get(key) ?? 0) + line.amountPence);
  }
  return lines.filter(isDiscount).map((line) => ({
    description: line.description,
    amountPence: -line.amountPence,
    categoryId: line.categoryId,
    disallowable: line.disallowable,
    beforePence: cost.get(groupKey(line)) ?? 0,
    afterPence: net.get(groupKey(line)) ?? 0,
  }));
}

/**
 * A discount typed in the form: an amount ("4.00", "£4") or a percentage ("10%") of what the items
 * it's taken off cost, to the nearest penny. Returns the pence taken off (positive), or null if invalid.
 */
export function parseDiscountAmount(text: string, itemsPence: number): number | null {
  // A minus sign is fine: it's a discount either way.
  const plain = text.trim().replace(/^[-–−]\s*/, '');
  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(plain);
  if (percent) {
    const rate = Number(percent[1]);
    if (!(rate > 0) || rate > 100) return null;
    const pence = Math.round((itemsPence * rate) / 100);
    return pence > 0 ? pence : null;
  }
  const pence = parsePoundsToPence(plain);
  return pence !== null && pence > 0 ? pence : null;
}

export const isPercentage = (text: string) => /%\s*$/.test(text);
