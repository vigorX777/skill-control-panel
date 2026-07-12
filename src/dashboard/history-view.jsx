import React from "react";
import { formatDate } from "./formatters.js";

export function HistoryView({ history, onPage }) {
  return (
    <section className="ledger-panel" aria-labelledby="history-heading">
      <div className="panel-heading"><div><p className="eyebrow">History / Append-only</p><h2 id="history-heading">操作历史</h2></div></div>
      <div className="table-frame"><table className="ledger-table history-table">
        <thead><tr><th>时间</th><th>操作人</th><th>Skill</th><th>行为</th><th>结果</th></tr></thead>
        <tbody>
          {history.items.map((event) => <tr key={event.id}>
            <td>{formatDate(event.timestamp)}</td><td>{event.actor?.agent || "unknown"}</td>
            <td><strong>{event.skillName || "--"}</strong></td><td><code>{event.action}</code></td><td>{event.result}</td>
          </tr>)}
          {history.items.length === 0 && <tr><td colSpan="5" className="empty-cell">暂无操作历史</td></tr>}
        </tbody>
      </table></div>
      <footer className="pagination">
        <button disabled={history.offset === 0} onClick={() => onPage(Math.max(0, history.offset - history.limit))}>上一页</button>
        <span>{history.total ? `${history.offset + 1}–${history.offset + history.items.length} / ${history.total}` : "0 / 0"}</span>
        <button disabled={history.nextOffset == null} onClick={() => onPage(history.nextOffset)}>下一页</button>
      </footer>
    </section>
  );
}

