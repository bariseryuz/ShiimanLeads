/**
 * Diagnostics for Column Extraction Issues
 * Helps identify why only one column is being extracted instead of both
 */

const { db } = require('../../db');
const logger = require('../../utils/logger');

/**
 * Diagnose a specific source configuration
 * Shows exactly what columns are configured and what's being extracted
 * 
 * @param {number} sourceId - Source ID to diagnose
 * @returns {Promise<Object>} Diagnostic report
 */
async function diagnoseSource(sourceId) {
  const report = {
    sourceId,
    timestamp: new Date().toISOString(),
    issues: [],
    warnings: [],
    info: []
  };

  try {
    // 1. Check source configuration
    logger.info(`🔍 Diagnosing source ${sourceId}...`);
    
    const sourceRow = db.prepare(
      `SELECT source_data FROM user_sources WHERE id = ?`
    ).get(sourceId);
    
    if (!sourceRow) {
      report.issues.push(`Source ID ${sourceId} not found in database`);
      return report;
    }
    
    let sourceConfig;
    try {
      sourceConfig = JSON.parse(sourceRow.source_data);
      report.info.push(`Source name: ${sourceConfig.name}`);
      report.info.push(`Source URL: ${sourceConfig.url}`);
    } catch (parseErr) {
      report.issues.push(`Failed to parse source_data JSON: ${parseErr.message}`);
      return report;
    }
    
    // 2. Check fieldSchema
    const fieldSchema = sourceConfig.fieldSchema || {};
    const fieldNames = Object.keys(fieldSchema);
    
    if (fieldNames.length === 0) {
      report.warnings.push('⚠️ No fieldSchema defined! Source will use AI defaults (permit_number, address, etc.)');
      report.info.push('Default fields will be: permit_number, address, construction_cost, contractor_name, phone, date_issued, permit_type');
    } else {
      report.info.push(`✅ Custom fieldSchema defined with ${fieldNames.length} field(s):`);
      fieldNames.forEach(name => {
        report.info.push(`   - ${name}`);
      });
    }
    
    // 3. Check source-specific table
    const tableName = `source_${sourceId}`;
    const tableExists = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
    ).get(tableName);
    
    if (!tableExists) {
      report.warnings.push(`Table ${tableName} does not exist yet (will be created on first scrape)`);
    } else {
      const tableInfo = db.prepare(`PRAGMA table_info(${tableName})`).all();
      const columns = tableInfo.map(col => col.name);
      
      report.info.push(`✅ Source table exists: ${tableName}`);
      report.info.push(`   Columns (${columns.length} total):`);
      columns.forEach(col => {
        report.info.push(`   - ${col}`);
      });
      
      // 4. Check for mismatches between fieldSchema and table columns
      const customFields = fieldNames.filter(f => !['id', 'user_id', 'raw_text', 'page_url', 'hash', 'source_name', 'created_at'].includes(f));
      for (const field of customFields) {
        if (!columns.includes(field)) {
          report.issues.push(`❌ MISMATCH: fieldSchema defines "${field}" but table doesn't have this column!`);
        }
      }
      
      const customColumns = columns.filter(c => !['id', 'user_id', 'raw_text', 'page_url', 'hash', 'source_name', 'created_at'].includes(c));
      for (const col of customColumns) {
        if (!fieldNames.includes(col)) {
          report.warnings.push(`⚠️ Table has column "${col}" but it's not in fieldSchema - might not be populated`);
        }
      }
    }
    
    // 5. Check extracted leads
    const leadCount = db.prepare(
      `SELECT COUNT(*) as count FROM ${tableName}`
    ).get()?.count || 0;
    
    if (leadCount > 0) {
      report.info.push(`✅ Found ${leadCount} leads in source table`);
      
      // Sample one lead to see what data was extracted
      const sampleLead = db.prepare(
        `SELECT * FROM ${tableName} LIMIT 1`
      ).get();
      
      if (sampleLead) {
        report.info.push(`Sample lead data:`);
        Object.entries(sampleLead).forEach(([key, value]) => {
          if (value != null && value !== '' && key !== 'raw_text') {
            report.info.push(`   ${key}: ${String(value).substring(0, 50)}`);
          }
        });
        
        // Check which fields are empty
        const fieldValues = {};
        Object.entries(sampleLead).forEach(([key, value]) => {
          fieldValues[key] = (value != null && value !== '');
        });
        
        const emptyFields = Object.entries(fieldValues)
          .filter(([k, v]) => !v && !['id', 'user_id', 'raw_text', 'hash', 'source_name', 'created_at'].includes(k))
          .map(([k]) => k);
        
        if (emptyFields.length > 0) {
          report.warnings.push(`⚠️ These custom fields are empty in sample lead: ${emptyFields.join(', ')}`);
        }
      }
    } else {
      report.info.push(`ℹ️ No leads in source table yet`);
    }
    
    // 6. Recommendations
    if (report.issues.length > 0) {
      report.recommendations = [
        '🔧 You have configuration issues. Here\'s how to fix:',
        '',
        '1. Check your source fieldSchema matches column names exactly',
        '2. If you see "MISMATCH" errors above, rebuild the table:',
        `   - Delete the source and re-add it with correct fieldSchema`,
        '',
        '3. Example correct fieldSchema:',
        `   {`,
        `     "permit_number": { "required": true },`,
        `     "address": { "required": false },`,
        `     "construction_cost": { "required": false }`,
        `   }`,
        '',
        '4. Field names in fieldSchema MUST EXACTLY MATCH database columns',
        '5. Only fields defined in fieldSchema will be populated'
      ];
    }
    
  } catch (err) {
    report.issues.push(`Diagnostic error: ${err.message}`);
  }
  
  return report;
}

/**
 * Print diagnostic report in readable format
 * 
 * @param {Object} report - Report from diagnoseSource()
 */
function printDiagnosticReport(report) {
  console.log('\n╔════════════════════════════════════════════════════════════════╗');
  console.log('║          SOURCE CONFIGURATION DIAGNOSTIC REPORT               ║');
  console.log('╚════════════════════════════════════════════════════════════════╝\n');
  
  console.log(`Source ID: ${report.sourceId}`);
  console.log(`Timestamp: ${report.timestamp}\n`);
  
  if (report.info.length > 0) {
    console.log('📋 INFORMATION:');
    report.info.forEach(line => console.log(`   ${line}`));
    console.log();
  }
  
  if (report.warnings.length > 0) {
    console.log('⚠️  WARNINGS:');
    report.warnings.forEach(line => console.log(`   ${line}`));
    console.log();
  }
  
  if (report.issues.length > 0) {
    console.log('❌ ISSUES:');
    report.issues.forEach(line => console.log(`   ${line}`));
    console.log();
  }
  
  if (report.recommendations) {
    console.log('💡 RECOMMENDATIONS:');
    report.recommendations.forEach(line => console.log(`   ${line}`));
    console.log();
  }
  
  console.log('════════════════════════════════════════════════════════════════\n');
}

/**
 * Compare what AI extracted vs what got inserted
 * Useful for debugging empty columns
 * 
 * @param {Object} aiExtracted - Data from AI extraction
 * @param {Object} fieldSchema - fieldSchema from source config
 * @param {Object} dbInserted - Data actually in database
 * @returns {Object} Comparison report
 */
function compareExtraction(aiExtracted, fieldSchema, dbInserted) {
  const report = {
    aiFields: Object.keys(aiExtracted || {}),
    schemaFields: Object.keys(fieldSchema || {}),
    dbFields: Object.keys(dbInserted || {}).filter(f => !['id', 'user_id', 'raw_text', 'hash', 'source_name', 'created_at', 'page_url'].includes(f)),
    mismatches: [],
    missing: [],
    extra: []
  };
  
  // Find fields AI extracted but aren't in schema
  report.extra = report.aiFields.filter(f => !report.schemaFields.includes(f) && !['_original', '_aiConfidence', '_validationIssues'].includes(f));
  
  // Find schema fields that didn't get extracted
  report.missing = report.schemaFields.filter(f => !report.aiFields.includes(f));
  
  // Find fields that weren't inserted in DB
  report.notInserted = report.aiFields.filter(f => !report.dbFields.includes(f));
  
  return report;
}

module.exports = {
  diagnoseSource,
  printDiagnosticReport,
  compareExtraction
};
