export interface DiceResult {
  expression: string;
  rolls: number[];
  modifier: number;
  total: number;
}

const TOKEN_RE = /([+-])?\s*(\d+)?d(\d+)(?:k([hl])(\d+))?|([+-])?\s*(\d+)(?!d)/gi;

export function roll(expression: string): DiceResult {
  const expr = expression.replace(/\s+/g, "");
  let total = 0;
  let modifier = 0;
  const rolls: number[] = [];
  const matches = expr.matchAll(TOKEN_RE);
  let any = false;
  for (const m of matches) {
    any = true;
    if (m[3]) {
      const sign = m[1] === "-" ? -1 : 1;
      const count = m[2] ? parseInt(m[2], 10) : 1;
      const sides = parseInt(m[3], 10);
      if (count > 100 || sides > 1000 || count < 1 || sides < 2) {
        throw new Error("Dice out of bounds");
      }
      const dice: number[] = [];
      for (let i = 0; i < count; i++) {
        dice.push(1 + Math.floor(Math.random() * sides));
      }
      let kept = dice;
      if (m[4] && m[5]) {
        const k = parseInt(m[5], 10);
        const sorted = [...dice].sort((a, b) => a - b);
        kept = m[4].toLowerCase() === "h" ? sorted.slice(-k) : sorted.slice(0, k);
      }
      rolls.push(...dice);
      total += sign * kept.reduce((s, n) => s + n, 0);
    } else if (m[7]) {
      const sign = m[6] === "-" ? -1 : 1;
      const n = parseInt(m[7], 10) * sign;
      modifier += n;
      total += n;
    }
  }
  if (!any) throw new Error("Invalid expression");
  return { expression, rolls, modifier, total };
}
