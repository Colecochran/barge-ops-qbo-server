'use strict';
// Parses raw QBO API report responses into clean dashboard-ready objects

function num(v) { return parseFloat(v || 0) || 0; }

function findSection(rows, group) {
  return rows.find(r => r.type === 'Section' && r.group === group) || null;
}

function extractValues(colData = []) {
  return colData.slice(1).map(c => num(c.value));
}

function collectDataRows(rows = []) {
    const out = [];

    for (const row of rows) {

        // DATA ROWS
        if (row.type === 'Data' && row.ColData) {
            const values = extractValues(row.ColData);

            out.push({
                name: row.ColData?.[0]?.value || '',
                id: row.ColData?.[0]?.id || null,
                values,
                total: values[values.length - 1] || 0
            });
        }

        // SECTION RECURSION
        else if (row.type === 'Section') {
            out.push(...collectDataRows(row.Rows?.Row || []));
        }

        // 🔥 SUMMARY ROWS (THIS WAS MISSING)
        else if (row.type === 'Section' && row.Summary?.ColData) {
            const values = extractValues(row.Summary.ColData);

            out.push({
                name: row.Header?.ColTitle || 'Summary',
                id: null,
                values,
                total: values[values.length - 1] || 0
            });
        }
    }

    return out;
}

function parsePnL(report) {
    if (!report?.Rows?.Row) return null;

    const allRows = report.Rows.Row;
    const colDefs = report.Columns?.Column || [];
    const months  = colDefs.slice(1, -1).map(c => c.ColTitle.replace(' 20', " '"));

    function sectionTotals(group) {
        const sec = findSection(allRows, group);
        if (!sec?.Summary?.ColData) return { monthly: [], total: 0 };
        const vals = extractValues(sec.Summary.ColData);
        return { monthly: vals.slice(0, months.length), total: vals[vals.length - 1] || 0 };
    }

    const income   = sectionTotals('Income');
    const cogs     = sectionTotals('COGS');
    const expenses = sectionTotals('Expenses');
    const grandRow = findNetIncome(allRows);
    const grandVals = extractRowValues(grandRow);

    const netIncome = {
        monthly: grandVals.slice(0, months.length),
        total: grandVals[grandVals.length - 1] || 0
    };

    const grossProfit = { monthly: income.monthly.map((v, i) => v - (cogs.monthly[i] || 0)), total: income.total - cogs.total };

    function lineItems(group) {
        const sec = findSection(allRows, group);
        return collectDataRows(sec?.Rows?.Row || []).map(item => ({
          ...item, monthly: item.values.slice(0, months.length), total: item.values[item.values.length - 1] || 0
        }));
    }

    const expenseSection = findSection(allRows, 'Expenses');

    return {
        months, income, cogs, expenses, grossProfit, netIncome,
        totalRevenue: income.total, totalCOGS: cogs.total,
        totalGrossProfit: grossProfit.total, totalExpenses: expenses.total, totalNetIncome: netIncome.total,
        netMarginPct:   income.total > 0 ? +(netIncome.total   / income.total * 100).toFixed(1) : 0,
        grossMarginPct: income.total > 0 ? +(grossProfit.total / income.total * 100).toFixed(1) : 0,
        incomeItems: lineItems('Income'), expenseItems: lineItems('Expenses'), cogsItems: lineItems('COGS'),
        reportPeriod: { start: report.Header?.StartPeriod, end: report.Header?.EndPeriod }
    };
}

function parsePnLByClass(report) {
  if (!report?.Rows?.Row || !report?.Columns?.Column) return [];
  const allRows = report.Rows.Row;
  const colDefs = report.Columns.Column;
  const classes = colDefs.slice(1, -1).map((c, i) => ({ name: c.ColTitle || `Class ${i+1}`, idx: i + 1 }));

  function sectionPerClass(group) {
    const sec = findSection(allRows, group);
    if (!sec?.Summary?.ColData) return classes.map(() => 0);
    const cd = sec.Summary.ColData;
    return classes.map(cl => num(cd[cl.idx]?.value));
  }

  const revenues = sectionPerClass('Income'), cogs = sectionPerClass('COGS'), exps = sectionPerClass('Expenses');
  return classes.map((cl, i) => {
    const rev = revenues[i], cos = cogs[i], exp = exps[i], gp = rev - cos, net = gp - exp;
    return { className: cl.name, revenue: rev, cogs: cos, expenses: exp, grossProfit: gp, netIncome: net,
      grossMargin: rev > 0 ? +(gp/rev*100).toFixed(1) : 0, netMargin: rev > 0 ? +(net/rev*100).toFixed(1) : 0 };
  });
}

function parseCustomerSales(report) {
  if (!report?.Rows?.Row) return [];
  const colDefs = report.Columns?.Column || [];
  const totalIdx = colDefs.length > 1 ? colDefs.length - 1 : 1;
  const results = [];
  function walk(rows) {
    for (const row of rows) {
      if (row.type === 'Data' && row.ColData) {
        const cd = row.ColData, val = num(cd[totalIdx]?.value || cd[cd.length-1]?.value);
        if (val > 0) results.push({ name: cd[0]?.value || 'Unknown', id: cd[0]?.id || null, revenue: val });
      } else if (row.type === 'Section') walk(row.Rows?.Row || []);
    }
  }
  walk(report.Rows.Row);
  return results.sort((a, b) => b.revenue - a.revenue);
}

function parseExpenseBreakdown(pnlReport) {
    const expenseSection = findSection(
        pnlReport.Rows.Row,
        "Expenses"
    );

    return expenseSection.Rows.Row
        .filter(r => r.type === "Section")
        .map(r => ({
            name: r.Header.ColData[0].value,
            total: extractValues(r.Summary.ColData).slice(-1)[0]
        }))
        .sort((a, b) => b.total - a.total);
}

function findNetIncome(allRows) {
    // 1. Try explicit GrandTotal row
    let row =
        allRows.find(r => r.type === 'GrandTotal') ||
        allRows.find(r => r.group === 'NetIncome') ||
        allRows.find(r => r.group === 'Net Income');

    // 2. If not found, try scanning for label
    if (!row) {
        row = allRows.find(r =>
            r?.ColData?.some(c =>
                c.value?.toLowerCase().includes('net income')
            )
        );
    }

    return row;
}

function extractRowValues(row) {
    if (!row) return [];

    // Try ColData first
    if (row.ColData?.length) {
        return extractValues(row.ColData);
    }

    // Fallback: Summary.ColData (VERY common in QBO)
    if (row.Summary?.ColData?.length) {
        return extractValues(row.Summary.ColData);
    }

    return [];
}

module.exports = { parsePnL, parsePnLByClass, parseCustomerSales, parseExpenseBreakdown };
