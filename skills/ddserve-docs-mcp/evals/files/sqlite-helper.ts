import { Database } from "bun:sqlite";

export function recordTransfer(db: Database, fromAccountId: string, toAccountId: string, amount: number): void {
  const debit = db.query("UPDATE accounts SET balance = balance - $amount WHERE id = $id");
  const credit = db.query("UPDATE accounts SET balance = balance + $amount WHERE id = $id");
  const transfer = db.transaction(() => {
    debit.run({ $id: fromAccountId, $amount: amount });
    credit.run({ $id: toAccountId, $amount: amount });
  });

  transfer();
}
