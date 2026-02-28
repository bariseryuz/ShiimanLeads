const express = require('express');
const router = express.Router();
const { Lead } = require('../../models');
const logger = require('../../utils/logger');

/**
 * GET /api/leads
 * Retrieve all leads or filtered leads
 * Query params: source, dateFrom, dateTo, search
 */
router.get('/', async (req, res) => {
  try {
    const { source, dateFrom, dateTo, search } = req.query;

    let query = {};

    // Filter by source
    if (source) {
      query.source = source;
    }

    // Filter by date range
    if (dateFrom || dateTo) {
      query.date = {};
      if (dateFrom) {
        query.date.$gte = new Date(dateFrom);
      }
      if (dateTo) {
        const endDate = new Date(dateTo);
        endDate.setHours(23, 59, 59, 999);
        query.date.$lte = endDate;
      }
    }

    // Search in name, company, email, phone
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { name: searchRegex },
        { company: searchRegex },
        { email: searchRegex },
        { phone: searchRegex }
      ];
    }

    // Execute query
    const leads = await Lead.find(query).limit(5000).lean();

    logger.info(`[API] Retrieved ${leads.length} leads`);
    res.json(leads);
  } catch (error) {
    logger.error(`Error retrieving leads: ${error.message}`);
    res.status(500).json({ error: 'Failed to retrieve leads' });
  }
});

/**
 * GET /api/leads/:id
 * Get a single lead by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const lead = await Lead.findById(req.params.id).lean();

    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    res.json(lead);
  } catch (error) {
    logger.error(`Error retrieving lead: ${error.message}`);
    res.status(500).json({ error: 'Failed to retrieve lead' });
  }
});

module.exports = router;
