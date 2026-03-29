const express = require("express");

module.exports = function (sql, requireAdmin) {
    const router = express.Router();

    // =====================
    // AGENT SALARY (basic + bonus + toggle)
    // =====================

    // Get salary for a specific agent
    router.get("/:agentId", requireAdmin, async (req, res) => {
        try {
            const { agentId } = req.params;
            const salary = await sql`
                SELECT * FROM agent_salaries WHERE agent_id = ${agentId}
            `;
            if (salary.length === 0) {
                return res.json(null);
            }
            res.json(salary[0]);
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch salary", details: err.message });
        }
    });

    // Create or update salary for an agent
    router.put("/:agentId", requireAdmin, async (req, res) => {
        try {
            const { agentId } = req.params;
            const { basic_salary, bonus, calculate_on_base } = req.body;

            if (basic_salary === undefined) {
                return res.status(400).json({ error: "Basic salary is required" });
            }

            const existing = await sql`
                SELECT id FROM agent_salaries WHERE agent_id = ${agentId}
            `;

            let result;
            if (existing.length > 0) {
                result = await sql`
                    UPDATE agent_salaries
                    SET basic_salary = ${basic_salary},
                        bonus = ${bonus || 0},
                        calculate_on_base = ${calculate_on_base !== undefined ? calculate_on_base : true},
                        updated_at = NOW()
                    WHERE agent_id = ${agentId}
                    RETURNING *
                `;
            } else {
                result = await sql`
                    INSERT INTO agent_salaries (agent_id, basic_salary, bonus, calculate_on_base)
                    VALUES (${agentId}, ${basic_salary}, ${bonus || 0}, ${calculate_on_base !== undefined ? calculate_on_base : true})
                    RETURNING *
                `;
            }
            res.json(result[0]);
        } catch (err) {
            res.status(500).json({ error: "Failed to save salary", details: err.message });
        }
    });

    // =====================
    // DEDUCTIONS
    // =====================

    // Get all deductions for an agent
    router.get("/:agentId/deductions", requireAdmin, async (req, res) => {
        try {
            const { agentId } = req.params;
            const deductions = await sql`
                SELECT * FROM salary_deductions
                WHERE agent_id = ${agentId}
                ORDER BY created_at DESC
            `;
            res.json(deductions);
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch deductions", details: err.message });
        }
    });

    // Add a deduction
    router.post("/:agentId/deductions", requireAdmin, async (req, res) => {
        try {
            const { agentId } = req.params;
            const { name, type, value } = req.body;

            if (!name || !type || value === undefined) {
                return res.status(400).json({ error: "Name, type, and value are required" });
            }

            const validTypes = ["percentage", "fixed", "days"];
            if (!validTypes.includes(type)) {
                return res.status(400).json({ error: "Type must be 'percentage', 'fixed', or 'days'" });
            }

            const result = await sql`
                INSERT INTO salary_deductions (agent_id, name, type, value)
                VALUES (${agentId}, ${name}, ${type}, ${value})
                RETURNING *
            `;
            res.json(result[0]);
        } catch (err) {
            res.status(500).json({ error: "Failed to add deduction", details: err.message });
        }
    });

    // Update a deduction
    router.put("/:agentId/deductions/:deductionId", requireAdmin, async (req, res) => {
        try {
            const { deductionId } = req.params;
            const { name, type, value, is_active } = req.body;

            const result = await sql`
                UPDATE salary_deductions
                SET name = COALESCE(${name || null}, name),
                    type = COALESCE(${type || null}, type),
                    value = COALESCE(${value !== undefined ? value : null}, value),
                    is_active = COALESCE(${is_active !== undefined ? is_active : null}, is_active)
                WHERE id = ${deductionId}
                RETURNING *
            `;

            if (result.length === 0) {
                return res.status(404).json({ error: "Deduction not found" });
            }
            res.json(result[0]);
        } catch (err) {
            res.status(500).json({ error: "Failed to update deduction", details: err.message });
        }
    });

    // Delete a deduction
    router.delete("/:agentId/deductions/:deductionId", requireAdmin, async (req, res) => {
        try {
            const { deductionId } = req.params;
            await sql`DELETE FROM salary_deductions WHERE id = ${deductionId}`;
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: "Failed to delete deduction", details: err.message });
        }
    });

    // =====================
    // OVERTIME
    // =====================

    // Get overtime entries for an agent (optionally filtered by month)
    router.get("/:agentId/overtime", requireAdmin, async (req, res) => {
        try {
            const { agentId } = req.params;
            const { month } = req.query;

            let overtimeEntries;
            if (month) {
                overtimeEntries = await sql`
                    SELECT * FROM salary_overtime
                    WHERE agent_id = ${agentId} AND month = ${month}
                    ORDER BY created_at DESC
                `;
            } else {
                overtimeEntries = await sql`
                    SELECT * FROM salary_overtime
                    WHERE agent_id = ${agentId}
                    ORDER BY created_at DESC
                `;
            }
            res.json(overtimeEntries);
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch overtime entries", details: err.message });
        }
    });

    // Add an overtime entry
    router.post("/:agentId/overtime", requireAdmin, async (req, res) => {
        try {
            const { agentId } = req.params;
            const { month, hours, rate_per_hour, note, type } = req.body;
            const entryType = type || "hours";

            const validTypes = ["hours", "days"];
            if (!validTypes.includes(entryType)) {
                return res.status(400).json({ error: "Type must be 'hours' or 'days'" });
            }

            if (!month || hours === undefined) {
                return res.status(400).json({ error: "Month and hours are required" });
            }

            if (entryType === "hours" && rate_per_hour === undefined) {
                return res.status(400).json({ error: "Rate per hour is required for hours-based overtime" });
            }

            const monthPattern = /^\d{4}-\d{2}$/;
            if (!monthPattern.test(month)) {
                return res.status(400).json({ error: "Month must be in YYYY-MM format" });
            }

            const result = await sql`
                INSERT INTO salary_overtime (agent_id, month, type, hours, rate_per_hour, note)
                VALUES (${agentId}, ${month}, ${entryType}, ${hours}, ${rate_per_hour || 0}, ${note || null})
                RETURNING *
            `;
            res.json(result[0]);
        } catch (err) {
            res.status(500).json({ error: "Failed to add overtime entry", details: err.message });
        }
    });

    // Delete an overtime entry
    router.delete("/:agentId/overtime/:overtimeId", requireAdmin, async (req, res) => {
        try {
            const { overtimeId } = req.params;
            await sql`DELETE FROM salary_overtime WHERE id = ${overtimeId}`;
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: "Failed to delete overtime entry", details: err.message });
        }
    });

    // =====================
    // SALARY CALCULATION & PAYSLIP
    // =====================

    // Calculate salary for an agent for a given month (preview, does not save)
    router.get("/:agentId/calculate/:month", requireAdmin, async (req, res) => {
        try {
            const { agentId, month } = req.params;
            const breakdown = await calculateSalary(sql, agentId, month);
            res.json(breakdown);
        } catch (err) {
            res.status(500).json({ error: "Failed to calculate salary", details: err.message });
        }
    });

    // Generate and save a payslip for a given month
    router.post("/:agentId/payslip/:month", requireAdmin, async (req, res) => {
        try {
            const { agentId, month } = req.params;

            const existingRecord = await sql`
                SELECT id FROM salary_records
                WHERE agent_id = ${agentId} AND month = ${month}
            `;
            if (existingRecord.length > 0) {
                return res.status(409).json({ error: "Payslip already exists for this month — delete it first to regenerate" });
            }

            const breakdown = await calculateSalary(sql, agentId, month);

            const result = await sql`
                INSERT INTO salary_records (agent_id, month, basic_salary, bonus, total_deductions, total_overtime, net_salary, details)
                VALUES (${agentId}, ${month}, ${breakdown.basic_salary}, ${breakdown.bonus}, ${breakdown.total_deductions}, ${breakdown.total_overtime}, ${breakdown.net_salary}, ${JSON.stringify(breakdown)})
                RETURNING *
            `;
            res.json(result[0]);
        } catch (err) {
            res.status(500).json({ error: "Failed to generate payslip", details: err.message });
        }
    });

    // Get all payslips for an agent
    router.get("/:agentId/payslips", requireAdmin, async (req, res) => {
        try {
            const { agentId } = req.params;
            const records = await sql`
                SELECT * FROM salary_records
                WHERE agent_id = ${agentId}
                ORDER BY month DESC
            `;
            res.json(records);
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch payslips", details: err.message });
        }
    });

    // Delete a payslip
    router.delete("/:agentId/payslips/:recordId", requireAdmin, async (req, res) => {
        try {
            const { recordId } = req.params;
            await sql`DELETE FROM salary_records WHERE id = ${recordId}`;
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: "Failed to delete payslip", details: err.message });
        }
    });

    return router;
};

// =====================
// SALARY CALCULATION LOGIC
// =====================

async function calculateSalary(sql, agentId, month) {
    const salaryRows = await sql`
        SELECT * FROM agent_salaries WHERE agent_id = ${agentId}
    `;
    if (salaryRows.length === 0) {
        throw new Error("No salary defined for this agent — set basic salary first");
    }

    const salary = salaryRows[0];
    const basicSalary = parseFloat(salary.basic_salary);
    const bonus = parseFloat(salary.bonus);
    const totalSalary = basicSalary + bonus;
    const calculateOnBase = salary.calculate_on_base;
    const calculationBase = calculateOnBase ? basicSalary : totalSalary;
    const DAYS_IN_MONTH = 30;
    const dayPrice = calculationBase / DAYS_IN_MONTH;

    // Calculate deductions
    const deductions = await sql`
        SELECT * FROM salary_deductions
        WHERE agent_id = ${agentId} AND is_active = true
    `;

    let totalDeductions = 0;
    const deductionBreakdown = deductions.map((deduction) => {
        const deductionValue = parseFloat(deduction.value);
        let amount;
        if (deduction.type === "percentage") {
            amount = (calculationBase * deductionValue) / 100;
        } else if (deduction.type === "days") {
            amount = dayPrice * deductionValue;
        } else {
            amount = deductionValue;
        }
        totalDeductions += amount;
        return {
            name: deduction.name,
            type: deduction.type,
            value: deductionValue,
            day_price: deduction.type === "days" ? Math.round(dayPrice * 100) / 100 : undefined,
            calculated_amount: Math.round(amount * 100) / 100,
        };
    });

    // Calculate overtime
    const overtimeEntries = await sql`
        SELECT * FROM salary_overtime
        WHERE agent_id = ${agentId} AND month = ${month}
    `;

    let totalOvertime = 0;
    const overtimeBreakdown = overtimeEntries.map((entry) => {
        const entryType = entry.type || "hours";
        const value = parseFloat(entry.hours);
        let amount;
        if (entryType === "days") {
            amount = dayPrice * value;
        } else {
            const ratePerHour = parseFloat(entry.rate_per_hour);
            amount = value * ratePerHour;
        }
        totalOvertime += amount;
        return {
            type: entryType,
            value,
            rate_per_hour: entryType === "hours" ? parseFloat(entry.rate_per_hour) : undefined,
            day_price: entryType === "days" ? Math.round(dayPrice * 100) / 100 : undefined,
            amount: Math.round(amount * 100) / 100,
            note: entry.note,
        };
    });

    const netSalary = totalSalary + totalOvertime - totalDeductions;

    return {
        agent_id: parseInt(agentId),
        month,
        basic_salary: basicSalary,
        bonus,
        total_salary: totalSalary,
        calculate_on_base: calculateOnBase,
        calculation_base: calculationBase,
        day_price: Math.round(dayPrice * 100) / 100,
        deductions: deductionBreakdown,
        total_deductions: Math.round(totalDeductions * 100) / 100,
        overtime: overtimeBreakdown,
        total_overtime: Math.round(totalOvertime * 100) / 100,
        net_salary: Math.round(netSalary * 100) / 100,
    };
}
