const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { body } = require('express-validator');

router.post('/register', [
    body('username').isString().notEmpty().trim(),
    body('password').isLength({ min: 6 }),
], authController.register);

router.post('/login', [
    body('username').isString().notEmpty().trim(),
    body('password').notEmpty(),
], authController.login);

router.post('/google-login', authController.googleLogin);

module.exports = router;
