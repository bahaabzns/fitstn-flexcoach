const TENANT_ID = process.env.TENANT_ID || 'fitstn';
const UTC_OFFSET = 2;

const SLA_RULES = {
    'Fit Solo Pro': { maxMinutes: 60,   days: [0,1,2,3,4,5], startHour: 12, endHour: 21, crossMidnight: false, priority: 1, isScheduled: false },
    'Fit Fam Pro':  { maxMinutes: 60,   days: [0,1,2,3,4,5], startHour: 12, endHour: 21, crossMidnight: false, priority: 2, isScheduled: false },
    'Fit Solo':     { maxMinutes: 1440, days: [0,1,2,3,4],   startHour: 11, endHour: 18, crossMidnight: false, priority: 3, isScheduled: false },
    'Fit Duo':      { maxMinutes: 1440, days: [0,1,2,3,4],   startHour: 11, endHour: 18, crossMidnight: false, priority: 3, isScheduled: false },
    'Fit Fam':      { maxMinutes: 1440, days: [0,1,2,3,4],   startHour: 11, endHour: 18, crossMidnight: false, priority: 3, isScheduled: false },
    'Fit Express':  { maxMinutes: null, days: [0,1,2,3,4],   startHour: 11, endHour: 18, crossMidnight: false, priority: 4, isScheduled: true  },
};

const PKG_ORDER = ['Fit Solo Pro', 'Fit Fam Pro', 'Fit Solo', 'Fit Duo', 'Fit Fam', 'Fit Express'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isInSLAWindow(msgTime, rule) {
    const localMs   = msgTime.getTime() + UTC_OFFSET * 3600000;
    const localDate = new Date(localMs);
    const localHour = localDate.getUTCHours();
    const localDay  = localDate.getUTCDay();
    if (rule.crossMidnight) {
        return (localHour >= rule.startHour && rule.days.includes(localDay)) || localHour < rule.endHour;
    }
    return rule.days.includes(localDay) && localHour >= rule.startHour && localHour < rule.endHour;
}

module.exports = { SLA_RULES, PKG_ORDER, DAY_NAMES, TENANT_ID, UTC_OFFSET, isInSLAWindow };
