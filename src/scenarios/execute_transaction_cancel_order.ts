import {
    assetDataUtils,
    BigNumber,
    ContractWrappers,
    ERC20TokenContract,
    generatePseudoRandomSalt,
    Order,
    orderHashUtils,
    signatureUtils,
    SignedOrder,
    transactionHashUtils,
} from '0x.js';
import { Web3Wrapper } from '@0x/web3-wrapper';

import { NETWORK_CONFIGS, TX_DEFAULTS } from '../configs';
import { DECIMALS, NULL_ADDRESS, UNLIMITED_ALLOWANCE_IN_BASE_UNITS } from '../constants';
import { contractAddresses } from '../contracts';
import { PrintUtils } from '../print_utils';
import { providerEngine } from '../provider_engine';
import { getRandomFutureDateInSeconds, runMigrationsOnceIfRequiredAsync } from '../utils';

/**
 * In this scenario a third party, called the sender, submits the cancel operation on behalf of the maker.
 * This allows a sender to pay the gas for the maker. It can be combined with a custom sender
 * contract with additional business logic (e.g checking a whitelist). Or the sender
 * can choose how and when the transaction should be submitted, if at all.
 * The maker creates and signs the order. The signed order and cancelOrder parameters for the
 * execute transaction function call are signed by the maker as a proof of cancellation.
 */
export async function scenarioAsync(): Promise<void> {
    await runMigrationsOnceIfRequiredAsync();
    PrintUtils.printScenario('Execute Transaction cancelOrderOrder');
    // Initialize the ContractWrappers, this provides helper functions around calling
    // 0x contracts as well as ERC20/ERC721 token contracts on the blockchain
    const contractWrappers = new ContractWrappers(providerEngine, { networkId: NETWORK_CONFIGS.networkId });
    // Initialize the Web3Wrapper, this provides helper functions around fetching
    // account information, balances, general contract logs
    const web3Wrapper = new Web3Wrapper(providerEngine);
    const [maker, taker, sender] = await web3Wrapper.getAvailableAddressesAsync();
    const feeRecipientAddress = sender;
    const zrxTokenAddress = contractAddresses.zrxToken;
    const etherTokenAddress = contractAddresses.etherToken;
    const printUtils = new PrintUtils(
        web3Wrapper,
        contractWrappers,
        { maker, taker, sender },
        { WETH: etherTokenAddress, ZRX: zrxTokenAddress },
    );
    printUtils.printAccounts();

    // the amount the maker is selling of maker asset
    const makerAssetAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(5), DECIMALS);
    // the amount the maker wants of taker asset
    const takerAssetAmount = Web3Wrapper.toBaseUnitAmount(new BigNumber(0.1), DECIMALS);
    // the amount of fees the maker pays in ZRX
    const makerFee = Web3Wrapper.toBaseUnitAmount(new BigNumber(0.01), DECIMALS);
    // the amount of fees the taker pays in ZRX
    const takerFee = Web3Wrapper.toBaseUnitAmount(new BigNumber(0.01), DECIMALS);
    // 0x v2 uses hex encoded asset data strings to encode all the information needed to identify an asset
    const makerAssetData = assetDataUtils.encodeERC20AssetData(zrxTokenAddress);
    const takerAssetData = assetDataUtils.encodeERC20AssetData(etherTokenAddress);
    let txHash;

    const zrxToken = new ERC20TokenContract(zrxTokenAddress, providerEngine);
    // Approve the ERC20 Proxy to move ZRX for maker
    const makerZRXApprovalTxHash = await zrxToken.approve.validateAndSendTransactionAsync(
        contractAddresses.erc20Proxy,
        UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
        { from: maker },
    );
    await printUtils.awaitTransactionMinedSpinnerAsync('Maker ZRX Approval', makerZRXApprovalTxHash);

    // Approve the ERC20 Proxy to move ZRX for taker
    const takerZRXApprovalTxHash = await zrxToken.approve.validateAndSendTransactionAsync(
        contractAddresses.erc20Proxy,
        UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
        { from: taker },
    );
    await printUtils.awaitTransactionMinedSpinnerAsync('Taker ZRX Approval', takerZRXApprovalTxHash);

    // Approve the ERC20 Proxy to move WETH for taker
    const takerWETHApprovalTxHash = await contractWrappers.weth9.approve.validateAndSendTransactionAsync(
        contractAddresses.erc20Proxy,
        UNLIMITED_ALLOWANCE_IN_BASE_UNITS,
        { from: taker },
    );
    await printUtils.awaitTransactionMinedSpinnerAsync('Taker WETH Approval', takerWETHApprovalTxHash);

    // Convert ETH into WETH for taker by depositing ETH into the WETH contract
    const takerWETHDepositTxHash = await contractWrappers.weth9.deposit.validateAndSendTransactionAsync({
        from: taker,
        value: takerAssetAmount,
    });
    await printUtils.awaitTransactionMinedSpinnerAsync('Taker WETH Deposit', takerWETHDepositTxHash);

    PrintUtils.printData('Setup', [
        ['Maker ZRX Approval', makerZRXApprovalTxHash],
        ['Taker ZRX Approval', takerZRXApprovalTxHash],
        ['Taker WETH Approval', takerWETHApprovalTxHash],
        ['Taker WETH Deposit', takerWETHDepositTxHash],
    ]);

    // Set up the Order and fill it
    const randomExpiration = getRandomFutureDateInSeconds();

    // Create the order
    const orderWithoutExchangeAddress = {
        makerAddress: maker,
        takerAddress: NULL_ADDRESS,
        senderAddress: sender,
        feeRecipientAddress,
        expirationTimeSeconds: randomExpiration,
        salt: generatePseudoRandomSalt(),
        makerAssetAmount,
        takerAssetAmount,
        makerAssetData,
        takerAssetData,
        makerFee,
        takerFee,
    };

    const exchangeAddress = contractAddresses.exchange;
    const order: Order = {
        ...orderWithoutExchangeAddress,
        exchangeAddress,
    };
    printUtils.printOrder(order);

    // Print out the Balances and Allowances
    await printUtils.fetchAndPrintContractAllowancesAsync();
    await printUtils.fetchAndPrintContractBalancesAsync();

    // Generate the order hash and sign it
    const orderHashHex = orderHashUtils.getOrderHashHex(order);
    const signature = await signatureUtils.ecSignHashAsync(providerEngine, orderHashHex, maker);

    const signedOrder: SignedOrder = {
        ...order,
        signature,
    };
    let orderInfo = await contractWrappers.exchange.getOrderInfo.callAsync(signedOrder);
    printUtils.printOrderInfos({ order: orderInfo });

    // This is an ABI encoded function call that the taker wishes to perform
    // in this scenario it is a fillOrder
    const cancelData = contractWrappers.exchange.cancelOrder.getABIEncodedTransactionData(signedOrder);
    // Generate a random salt to mitigate replay attacks
    const makerCancelOrderTransactionSalt = generatePseudoRandomSalt();
    // The maker signs the operation data (cancelOrder) with the salt
    const zeroExTransaction = {
        data: cancelData,
        salt: makerCancelOrderTransactionSalt,
        signerAddress: maker,
        verifyingContractAddress: contractAddresses.exchange,
    };
    const executeTransactionHex = transactionHashUtils.getTransactionHashHex(zeroExTransaction);
    const makerCancelOrderSignatureHex = await signatureUtils.ecSignHashAsync(
        providerEngine,
        executeTransactionHex,
        maker,
    );
    // The sender submits this operation via executeTransaction passing in the signature from the taker
    txHash = await contractWrappers.exchange.executeTransaction.validateAndSendTransactionAsync(
        zeroExTransaction.salt,
        zeroExTransaction.signerAddress,
        zeroExTransaction.data,
        makerCancelOrderSignatureHex,
        {
            gas: TX_DEFAULTS.gas,
            from: sender,
        },
    );
    const txReceipt = await printUtils.awaitTransactionMinedSpinnerAsync('executeTransaction', txHash);
    printUtils.printTransaction('Execute Transaction cancelOrderOrder', txReceipt, [['orderHash', orderHashHex]]);

    orderInfo = await contractWrappers.exchange.getOrderInfo.callAsync(signedOrder);
    printUtils.printOrderInfos({ order: orderInfo });

    // Stop the Provider Engine
    providerEngine.stop();
}

void (async () => {
    try {
        if (!module.parent) {
            await scenarioAsync();
        }
    } catch (e) {
        console.log(e);
        providerEngine.stop();
        process.exit(1);
    }
})();
