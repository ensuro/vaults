// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {AggregatorV3Interface} from "../dependencies/chainlink/AggregatorV3Interface.sol";

contract ChainlinkOracleMock is AggregatorV3Interface {
  uint8 public decimals;
  string public description;
  uint256 public version;

  struct Round {
    uint80 roundId;
    int256 answer;
    uint256 startedAt;
    uint256 updatedAt;
    uint80 answeredInRound;
  }

  mapping(uint80 => Round) internal _rounds;
  uint80 public lastRoundId;

  constructor(uint8 decimals_, string memory description_, uint256 version_) {
    decimals = decimals_;
    description = description_;
    version = version_;
  }

  function addRound(
    uint80 roundId,
    int256 answer,
    uint256 startedAt,
    uint256 updatedAt,
    uint80 answeredInRound
  ) external {
    _rounds[roundId] = Round(roundId, answer, startedAt, updatedAt, answeredInRound);
    if (roundId > lastRoundId) lastRoundId = roundId;
  }

  function getRoundData(
    uint80 _roundId
  )
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    Round storage round = _rounds[_roundId];
    return (round.roundId, round.answer, round.startedAt, round.updatedAt, round.answeredInRound);
  }

  function latestRoundData()
    external
    view
    returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  {
    Round storage round = _rounds[lastRoundId];
    return (round.roundId, round.answer, round.startedAt, round.updatedAt, round.answeredInRound);
  }
}
