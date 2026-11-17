import {fmtClock} from './format.js';
import {taskProgress} from './home.js';

export const GLANCE_IDLE_TITLE = 'Nothing playing';
export const GLANCE_IDLE_SUB = 'Click to open the dashboard';

export function glanceChips({agents = [], tasks = [], timer = null, containers = 0, now = Date.now()} = {}) {
    const chips = [];
    if (agents.some(a => a?.state === 'approval'))
        chips.push({id: 'claude', icon: 'agent', color: '#ff9f0a', label: 'Claude is waiting'});
    const build = tasks.find(t => t?.kind === 'task');
    if (build) {
        const {pct} = taskProgress(build, now);
        const label = pct === null
            ? `Build ${fmtClock((now - (build.startedAt ?? now)) / 1000)}`
            : `Build ${Math.floor(pct * 100)}%`;
        chips.push({id: 'build', icon: 'system-run-symbolic', color: '#0a84ff', label});
    }
    if (timer?.endsAt) {
        const name = timer.title === 'Break' ? 'Break' : 'Focus';
        chips.push({id: 'focus', icon: 'alarm-symbolic', color: '#ff375f', label: `${name} ${fmtClock((timer.endsAt - now) / 1000)}`});
    }
    if (containers > 0) {
        chips.push({
            id: 'docker', icon: 'network-server-symbolic', color: '#40c8e0',
            label: `${containers} container${containers === 1 ? '' : 's'}`,
        });
    }
    return chips;
}
