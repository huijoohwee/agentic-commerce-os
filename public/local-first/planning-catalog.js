// Rates use percentage points; monetary inputs use the plan currency's major unit.
const field = (label, unit, max, initial) => ({ label, unit, max, initial });
export const OFFER_INPUTS = {
  opening: field('Opening subscribers', 'count', 100000, 0),
  leads: field('Monthly inquiries', 'count', 100000, 12),
  convert: field('Inquiry conversion', '%', 100, 25),
  growth: field('Monthly inquiry growth', '%', 10, 1),
  churn: field('Monthly cancellation rate', '%', 100, 2),
  price: field('Recurring price', 'money', 1e9, 24),
  cost: field('Service cost per subscriber', 'money', 3e9, 6),
  cac: field('Cost per acquisition', 'money', 1e9, 18),
};
export const COMPANY_INPUTS = {
  openingCash: field('Opening cash', 'money', 1e9, 5000),
  overhead: field('Monthly operating budget', 'money', 1e7, 220),
  staff: field('Opening team size', 'count', 10000, 1),
  hires: field('New staff at hiring date', 'count', 10000, 0),
  hiring: field('Hiring month', 'period', 24, 6),
  wages: field('Monthly cost per staff member', 'money', 1e6, 550),
  tools: field('Tools budget per month', 'money', 1e7, 48),
  capex: field('Monthly equipment purchases', 'money', 1e7, 20),
  receivable: field('Sales collected next month', '%', 100, 10),
  payable: field('Service costs paid next month', '%', 100, 5),
  finance: field('Equity funding amount', 'money', 1e9, 0),
  funding: field('Funding month', 'period', 24, 12),
  target: field('Target lifetime value / acquisition cost', 'ratio', 100, 3),
};
export const defaults = fields => Object.fromEntries(Object.entries(fields).map(([key, spec]) => [key, spec.initial]));
export const PAGES = [
  ['volume','Commercial plan/Volume and revenue'],['inputs','Commercial plan/Assumptions'],
  ['segments','Commercial plan/Offer mapping'],['statements','Commercial plan/Financial statements'],
  ['retention','Growth/Subscriber retention'],['funnel','Growth/Acquisition funnel'],['unit','Growth/Unit economics'],
  ['compare','Decisions/Scenario comparison'],['sensitivity','Decisions/Driver sensitivity'],['profit','Decisions/Profitability and runway'],
  ['budget','Operations/Operating budget'],['staffing','Operations/Staffing schedule'],['tools','Operations/Tool spending'],
  ['actuals','Commercial plan/Plan and settlements'],['dashboard','Growth/Subscriber dashboard'],
  ['expenses','Operations/Expense requests'],['timeline','Operations/Budget timeline'],
  ['board','Reporting/Board packet'],['identity','Reporting/Brand notes'],['mail','Reporting/Message draft'],
  ['reconcile','Operations/Balance checks'],['report','Reporting/Management brief'],['sources','Source files/Model sources'],
].map(([id,name]) => ({id,name,title:name.split('/').at(-1)}));
const metric = (label, unit='money', aggregation='sum') => ({label,unit,aggregation});
export const METRICS = {
  leads:metric('Inquiries','count'), added:metric('New subscribers','count'), lost:metric('Cancellations','count'),
  active:metric('Closing subscribers','count','last'), opening:metric('Opening subscribers','count','first'),
  recurring:metric('Subscription billings'), runRate:metric('Annualized billings','money','last'),
  service:metric('Service expense'), acquisition:metric('Acquisition spending'), margin:metric('Gross profit'),
  arpu:metric('Revenue per subscriber','money','weighted'), churnRate:metric('Cancellation rate','%','weighted'),
  marginRate:metric('Gross margin','%','weighted'), cac:metric('Acquisition cost per new subscriber','money','weighted'),
  lifetime:metric('Estimated subscriber lifetime value','money','weighted'), multiple:metric('Lifetime value / acquisition cost','ratio','weighted'),
  conversion:metric('Inquiry conversion','%','weighted'), original:metric('Retained opening cohort','count','last'),
  staff:metric('Staff on payroll','count','last'), payroll:metric('Payroll expense'), tools:metric('Tools expense'),
  overhead:metric('Operating expense budget'), opex:metric('Total operating expenses'), result:metric('Operating result'),
  funding:metric('Capital received'), capex:metric('Equipment purchases'), receipts:metric('Cash collected'), paid:metric('Cash paid to suppliers'),
  cashFlow:metric('Net cash movement'), cash:metric('Closing cash','money','last'), equipment:metric('Equipment at cost','money','last'),
  ar:metric('Receivables','money','last'), ap:metric('Payables','money','last'), equity:metric('Closing equity','money','last'),
  assets:metric('Total assets','money','last'), liabilitiesEquity:metric('Liabilities and equity','money','last'),
  check:metric('Balance difference','money','last'), burn:metric('Operating cash burn'), runway:metric('Cash coverage at current burn','months','last')
};
export const PAGE_METRICS = {
 volume:['leads','added','lost','active','recurring','runRate','arpu'], retention:['opening','lost','active','original','churnRate'],
 funnel:['leads','added','conversion','acquisition','cac'], unit:['arpu','marginRate','churnRate','lifetime','cac','multiple'],
 statements:['recurring','service','margin','opex','result','receipts','paid','capex','funding','cashFlow','cash','ar','equipment','assets','ap','equity','liabilitiesEquity'],
 profit:['recurring','opex','result','burn','cash','runway'], budget:['service','acquisition','payroll','tools','overhead','opex','result'],
 staffing:['staff','payroll'],tools:['tools','opex'],reconcile:['cash','ar','equipment','assets','ap','equity','liabilitiesEquity','check'],
};
export const formatValue = (value,unit,currency) => value == null ? '—' : new Intl.NumberFormat(undefined,
 unit === 'money' ? {style:'currency',currency,maximumFractionDigits:2} : {maximumFractionDigits:2}).format(value)
 + (unit === '%' ? '%' : unit === 'ratio' ? '×' : unit === 'months' ? ' mo' : '');
