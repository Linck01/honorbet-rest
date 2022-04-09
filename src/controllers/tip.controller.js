const httpStatus = require('http-status');
const pick = require('../utils/pick');
const fct = require('../utils/fct');
const ApiError = require('../utils/ApiError');
const catchAsync = require('../utils/catchAsync');
const { tipService, betService, gameService, memberService, userService } = require('../services');
const socket = require('../utils/socket');
const { verify } = require('hcaptcha');
const config = require('../config/config');

const createTip = catchAsync(async (req, res) => {
  if (!req.user) 
    throw new ApiError(httpStatus.UNAUTHORIZED, 'Not authorized.');

  if (req.user.captchaTicker % config.captchaTickerInterval == 0) {
    if (!req.body.captchaToken)
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Could not verify captcha.');

    const captcha = await verify(config.captchaSecret,req.body.captchaToken);
    if (!captcha.success)
      throw new ApiError(httpStatus.UNAUTHORIZED, 'Could not verify captcha.');
  }
  
  const tipBody = req.body;
  tipBody.userId = req.user.id;
  let bet = await betService.getBetById(tipBody.betId);
  if (!bet) 
    throw new ApiError(httpStatus.NOT_FOUND, 'Bet not found.');
  
  const game = await gameService.getGameById(tipBody.gameId);
  if (!game) 
    throw new ApiError(httpStatus.NOT_FOUND, 'Game not found.');
  
  if (fct.getTimeDifferenceToNow(bet.timeLimit) > 0 || bet.isSolved || bet.isAborted)
    throw new ApiError(httpStatus.NOT_ACCEPTABLE, 'Cannot add tip - Bet has ended, is solved or was aborted.');

  let member = await memberService.findOne({userId: tipBody.userId, gameId: tipBody.gameId});
  if(!member)
    member = await memberService.createMember({ gameId: tipBody.gameId, userId: tipBody.userId, currency: game.startCurrency })

  if (member.currency < tipBody.currency) 
    throw new ApiError(httpStatus.NOT_ACCEPTABLE, 'Not enough points to spend.');

  if (tipBody.currency <= 0) 
    throw new ApiError(httpStatus.NOT_ACCEPTABLE, 'Currency must be greater than 0.');

  const randomTipFromUser = await tipService.findOne({betId: tipBody.betId, userId: tipBody.userId });
  // Decrement currency
  await memberService.increment(tipBody.gameId,tipBody.userId,'currency', -tipBody.currency);
  
  let tip;
  if (bet.betType == 'catalogue')
    tip = await catalogueTipCreate(tipBody);
  if (bet.betType == 'scale')
    tip = await scaleTipCreate(tipBody,bet);
  
  // Increment bet memberCount (if user has not placed a tip on any answer)
  if (!randomTipFromUser)
    await betService.increment(tipBody.betId,'memberCount',1);
  
  // Increment bet inPot
  await betService.increment(tipBody.betId, 'inPot', tipBody.currency);

  // Increment user captchaTicker
  await userService.increment(tipBody.userId, 'captchaTicker', 1);

  // Send socket message
  member = await memberService.findOne({userId: tipBody.userId, gameId: tipBody.gameId})
  bet = await betService.getBetById(tipBody.betId);
  await socket.sendNewTipToGame(tip,bet,member);

  res.status(httpStatus.CREATED).send(tip);
});

const catalogueTipCreate = async (tipBody) => {
  // Add/Increment tip
  const duplicateTip = await tipService.findOne({betId: tipBody.betId, userId: tipBody.userId, answerId: tipBody.answerId });

  let tip;
  if (duplicateTip) {
    await tipService.increment(duplicateTip.id,'currency',tipBody.currency);
    tip = await tipService.findOne({betId: tipBody.betId, userId: tipBody.userId, answerId: tipBody.answerId });
  } else {
    // Increment answer memberCount (if user has not placed a tip on that specific answer)
    await betService.increment(tipBody.betId,'catalogue_answers.' + tipBody.answerId + '.memberCount', 1);

    tip = await tipService.createTip(tipBody);
  }
  
  // Increment answer inPot
  await betService.increment(tipBody.betId,'catalogue_answers.' + tipBody.answerId + '.inPot', tipBody.currency);

  return tip;
};

const scaleTipCreate = async (tipBody,bet) => {
  // Add/Increment tip
  const duplicateTip = await tipService.findOne({betId: tipBody.betId, userId: tipBody.userId, answerDecimal: tipBody.answerDecimal});
  const interval = getScaleInterval(tipBody.answerDecimal, bet.scale_answers);

  const intervalFilter = interval.to ? { $gte: interval.from,  $lt: interval.to } : { $gte: interval.from };
  const intervalTip = await tipService.findOne({betId: tipBody.betId, userId: tipBody.userId, answerDecimal: intervalFilter});

  let tip;
  if (duplicateTip) {
    await tipService.increment(duplicateTip.id,'currency',tipBody.currency);
    tip = await tipService.findOne({betId: tipBody.betId, userId: tipBody.userId, answerDecimal: tipBody.answerDecimal});
  } else {
    tip = await tipService.createTip(tipBody);
  }

  // Increment interval memberCount (if user has not placed a tip on that specific interval)
  if (!intervalTip) {
    await betService.increment(tipBody.betId,'scale_answers.' + interval.index + '.memberCount', 1);
  }

  // Increment interval inPot
  await betService.increment(tipBody.betId, 'scale_answers.' + interval.index + '.inPot', tipBody.currency);
  
  return tip;
};

const getTips = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['betId', 'userId']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await tipService.queryTips(filter, options);

  console.log('SSSSSSSSSSSSSSSSSSSSSSSSSSSS',result);
  res.send(result);
  
  /*res.send({
       results: [
         {
           currency: 20,
           _id: '624f4a0596ef280022ae9934',
           betId: '624f488a96ef280022ae98cd',
           userId: '624f496c96ef280022ae98fa',
           gameId: '624f485e96ef280022ae98bb',
           answerId: 1,
           _createdAt: '2022-04-07T20:31:01.417Z',
           _updatedAt: '2022-04-07T20:31:01.417Z',
           __v: 0
         },
         {
           currency: 11,
           _id: '624f48bf96ef280022ae98ec',
           betId: '624f488a96ef280022ae98cd',
           userId: '624f47ba96ef280022ae98ab',
           gameId: '624f485e96ef280022ae98bb',
           answerId: 0,
           _createdAt: '2022-04-07T20:25:35.186Z',
           _updatedAt: '2022-04-07T20:25:35.186Z',
           __v: 0
         }
       ],
       page: 1,
       limit: 8,
       totalPages: 1,
       totalResults: 2,
       test: 'test2'
     });*/
});


const getScaleInterval = (value,scale_answers) => {
  let from, to, index;

  for (let i = 0; i < scale_answers.length; i++) {
    if (value >= parseFloat(scale_answers[i].from.toString())) {
      
      index = i;
      from = parseFloat(scale_answers[i].from.toString());
      if (scale_answers[i+1])
        to = parseFloat(scale_answers[i+1].from.toString());
      else
        to = null;
    }
  }

  return { index, from, to };
};


/*
const getTip = catchAsync(async (req, res) => {
  const tip = await tipService.getTipById(req.params.tipId);
  res.send(tip);
});

/*
const updateTip = catchAsync(async (req, res) => {
  const tip = await tipService.updateTipById(req.params.tipId, req.body);
  res.send(tip);
});

const deleteTip = catchAsync(async (req, res) => {
  await tipService.deleteTipById(req.params.tipId);
  res.status(httpStatus.NO_CONTENT).send();
});
*/

module.exports = {
  createTip,
  getTips
};
