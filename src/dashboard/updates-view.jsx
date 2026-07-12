import React from "react";
import { getSourceHref, getUpdateInstances, updateCommand } from "./formatters.js";

export function UpdatesView({ skills, onOpen }) {
  const available = skills.flatMap((skill) => getUpdateInstances(skill).map((instance) => ({ skill, instance })));
  return (
    <section className="ledger-panel" aria-labelledby="updates-heading">
      <div className="panel-heading"><div><p className="eyebrow">Updates / Confirmed only</p><h2 id="updates-heading">可用更新</h2></div></div>
      {available.length === 0 ? (
        <div className="quiet-empty"><span>∅</span><p>没有确认存在的可用更新</p></div>
      ) : (
        <div className="update-list">
          {available.map(({ skill, instance }) => {
            const sourceHref = getSourceHref(instance.source);
            return (
              <article className="update-entry" key={instance.id}>
                <button className="entry-title" data-detail-trigger="true" onClick={(event) => onOpen(skill, event.currentTarget)}>{skill.name} · {instance.scope?.level}</button>
                <div className="version-transition"><code>{instance.version?.current || "--"}</code><span>→</span><code>{instance.update.latest || "--"}</code></div>
                <div>{sourceHref ? <a href={sourceHref} target="_blank" rel="noreferrer">来源 ↗</a> : <span className="muted">--</span>}</div>
                <code className="command-line">{updateCommand(instance)}</code>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
