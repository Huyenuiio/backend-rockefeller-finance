const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const authMiddleware = require('../middleware/auth');
const { body } = require('express-validator');

router.use(authMiddleware);

router.get('/initial-budget', userController.getInitialBudget);
router.post('/initial-budget', [
    body('initialBudget').isFloat({ min: 0 }),
], userController.updateInitialBudget);

router.get('/expenses', userController.getExpenses);
router.post('/expenses', [
    body('amount').isFloat({ min: 0 }),
    body('category').isString().notEmpty(),
    body('purpose').isString().notEmpty(),
    body('location').isString().notEmpty(),
    body('date').optional().isString(),
], userController.addExpense);
router.post('/expenses/bulk', userController.bulkAddExpenses);
router.delete('/expenses/:index', userController.deleteExpense);

router.get('/allocations', userController.getAllocations);
router.post('/allocations', [
    body('essentials').isFloat({ min: 0 }),
    body('savings').isFloat({ min: 0 }),
    body('selfInvestment').isFloat({ min: 0 }),
    body('charity').isFloat({ min: 0 }),
    body('emergency').isFloat({ min: 0 }),
], userController.updateAllocations);

router.delete('/account', userController.deleteAccount);
router.delete('/budget', userController.resetBudget);

router.get('/investments', userController.getInvestments);
router.post('/investments', [
    body('amount').isFloat({ min: 0 }),
    body('price').isFloat({ min: 0 }),
    body('type').isString().notEmpty(),
], userController.addInvestment);
router.delete('/investments/:index', userController.deleteInvestment);

module.exports = router;
