const express = require('express');
const router = express.Router();
const bitcoinController = require('../controllers/bitcoinController');

router.get('/bitcoin-price', bitcoinController.getBitcoinPrice);
router.get('/bitcoin-history', bitcoinController.getBitcoinHistory);

module.exports = router;
